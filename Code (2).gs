/**
 * MAI ZAIN — نظام التشغيل والتوزيع · النسخة 11.0
 * الخادم على Google Apps Script، والبيانات في Google Sheets.
 *
 * النشر: Execute as: Me — Who has access: Anyone.
 * الحماية كلها على الخادم: كل استدعاء من الواجهة يحتاج جلسة دخول صحيحة (رمز يصدره الخادم بعد التحقق من كلمة المرور)،
 * وتُفحص صلاحية الدور على الخادم، ويُقفل الحساب مؤقتًا بعد محاولات خاطئة متكررة. لا تصل الواجهة إلى Google Sheets مباشرة.
 * كل كتابة على الجداول تمر عبر LockService لمنع تداخل حفظ المناديب والموظفين.
 *
 * التخزين:
 *   _state           (مخفية) حالة النظام كاملة بصيغة JSON مقسّمة على خلايا، مع رقم إصدار.
 *   _kv              (مخفية) المستخدمون (بدون كلمات المرور)، النشاط، البريد الخاص، طلبات الاستعادة.
 *   سجل التدقيق       إضافة فقط: عمليات المستخدمين داخل النظام.
 *   سجل الخادم        إضافة فقط: كل حفظ مع اسم المستخدم الذي نفّذه.
 *   سجل الأعطال       إضافة فقط: الأعطال المسجّلة تلقائيًا من أجهزة الموظفين ومن الخادم.
 *   طلبات النموذج     الطلبات الواردة من صفحة الطلب العامة ومن نموذج Google وحالة كل طلب.
 *   باقي الأوراق      نسخة مقروءة تُحدَّث تلقائيًا (العملاء، الطلبات، الفواتير، عهدة المناديب، أمانات العبوات...).
 */

var VERSION = '11.0.3';
var CHUNK = 45000;                       // أقل من حد الخلية (50,000 حرف)
var KV_COLS = ['users', 'activity', 'private', 'recovery'];
var SH = {
  state: '_state',
  kv: '_kv',
  audit: 'سجل التدقيق',
  server: 'سجل الخادم',
  err: 'سجل الأعطال',
  web: 'طلبات النموذج'
};
var ERR_HEAD = ['الوقت', 'الحساب', 'المستخدم', 'الاسم', 'الدور', 'المصدر', 'الرسالة', 'التفاصيل', 'الشاشة', 'الجهاز'];
var CELLS_LIMIT = 10000000;              // حد Google Sheets لعدد الخلايا في الملف
var MIRROR = [
  ['c', 'العملاء'], ['o', 'الطلبات'], ['pf', 'الفواتير المبدئية'], ['iv', 'الفواتير'], ['p', 'التحصيلات'],
  ['x', 'المصروفات'], ['pu', 'المشتريات'], ['sp', 'سداد الموردين'], ['mv', 'حركات المخزون'],
  ['pr', 'الأصناف'], ['cl', 'الإغلاقات اليومية'], ['dp', 'السندات'],
  ['van', 'عهدة المناديب'], ['vd', 'فروقات عهدة المناديب'], ['dc', 'تصفية خزينة المناديب'], ['bl', 'حركة أمانات العبوات']
];
var BACKUP_FOLDER = 'MAI ZAIN — نسخ احتياطية';
var BACKUP_KEEP = 90;
var ADMIN = 'مدير النظام';
var ROLE_PERMS = {
  'مدير النظام': ['*'],
  'المدير العام': ['approve', 'note', 'web'],
  'المبيعات': ['cust.edit', 'ord.new', 'dep.new', 'web'],
  'مندوب التوزيع': ['ord.deliver'],
  'مسؤول المخزون': ['inv.edit'],
  'المحاسب / المالية': ['pay', 'exp', 'close', 'iv.new', 'dep.new', 'dep.ret']
};
var SESS_TTL = 21600;                    // أقصى مدة يسمح بها CacheService (6 ساعات، وتتجدد مع الاستخدام)
var LOGIN_MAX = 5, LOCK_SEC = 900;       // 5 محاولات خاطئة ← إيقاف 15 دقيقة
var CUR_ = null;                         // جلسة الطلب الحالي (للسجلات)
var EMS_ = ['أبوظبي', 'دبي', 'الشارقة', 'عجمان', 'أم القيوين', 'رأس الخيمة', 'الفجيرة'];

/* ───────────── الواجهة ───────────── */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.p === 'order') {
    return HtmlService.createHtmlOutputFromFile('Order')
      .setTitle('MAI ZAIN — اطلب مياهك | Order water')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  if (!PropertiesService.getScriptProperties().getProperty('SS_ID')) {
    return HtmlService.createHtmlOutput('<p dir="rtl" style="font-family:sans-serif">النظام غير مُعدّ بعد. شغّل الدالة setup من محرر Apps Script.</p>');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('MAI ZAIN — نظام التشغيل والتوزيع')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** واجهة برمجية لاستقبال الطلبات من أي موقع أو استمارة خارجية (JSON بنفس حقول صفحة الطلب). */
function doPost(e) {
  var o;
  try { o = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return json_({ ok: false, error: 'invalid JSON' }); }
  try { return json_(pubOrder(o)); } catch (x) { return json_({ ok: false, error: String((x && x.message) || x) }); }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────── الإعداد (يُشغَّل مرة واحدة من المحرر) ───────────── */

function setup() {
  editorOnly_();
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss && props.getProperty('SS_ID')) ss = SpreadsheetApp.openById(props.getProperty('SS_ID'));
  if (!ss) ss = SpreadsheetApp.create('MAI ZAIN — قاعدة البيانات');
  props.setProperty('SS_ID', ss.getId());

  sheet_(ss, SH.state, true);
  sheet_(ss, SH.kv, true);
  var a = sheet_(ss, SH.audit, false);
  if (a.getLastRow() === 0) a.appendRow(['الوقت', 'المستخدم', 'الاسم', 'الدور', 'العملية', 'المصدر']);
  var s = sheet_(ss, SH.server, false);
  if (s.getLastRow() === 0) s.appendRow(['الوقت', 'المستخدم', 'العملية', 'الإصدار', 'الحجم']);
  var er = errSheet_(ss);
  [a, s, er].forEach(function (x) { x.setFrozenRows(1); x.setRightToLeft(true); });
  a.getRange('A:A').setNumberFormat('@');
  secret_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'mirror' || f === 'backup' || f === 'dailyReport' || f === 'monthlyReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('mirror').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('backup').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(21).inTimezone('Asia/Dubai').create();
  ScriptApp.newTrigger('monthlyReport').timeBased().onMonthDay(1).atHour(8).inTimezone('Asia/Dubai').create();

  Logger.log('تم الإعداد (النسخة ' + VERSION + '). قاعدة البيانات: ' + ss.getUrl());
  return ss.getUrl();
}

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('MAI ZAIN')
      .addItem('تحديث الجداول المقروءة الآن', 'mirror')
      .addItem('نسخة احتياطية الآن', 'backup')
      .addItem('إرسال التقرير اليومي الآن', 'dailyReport')
      .addItem('إرسال التقرير الشهري الآن', 'monthlyReport')
      .addSeparator()
      .addItem('استيراد بيانات من ملف في Drive', 'importFromDrive')
      .addToUi();
  } catch (e) { /* ليس في سياق جدول */ }
}

/** استعادة الدخول عند نسيان كلمة مرور مدير النظام: شغّلها من المحرر، وتظهر كلمة مرور مؤقتة في سجل التنفيذ. */
function resetAdminPassword() {
  editorOnly_();
  var all = users_(), u = Object.keys(all).filter(function (k) { return all[k].role === ADMIN; })
    .sort(function (a, b) { return (all[b].active !== false) - (all[a].active !== false); })[0];
  if (!u) throw new Error('لا يوجد حساب مدير نظام. افتح النظام لإنشاء الحساب الأول.');
  var A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', pw = '';
  var rnd = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now(), Utilities.Charset.UTF_8);
  for (var i = 0; i < 12; i++) pw += A.charAt((rnd[i] + 128) % A.length);
  var salt = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid(), Utilities.Charset.UTF_8).slice(0, 16));
  var x = all[u];
  x.salt = salt; x.h2 = hash_(pbkdf2_(pw, salt, 150000) + ':' + u); delete x.hash;
  x.active = true; x.pwAt = new Date().toISOString(); x.pwBy = 'owner';
  putUser_(x); bump_(u);
  cache_().remove('LL:' + u); cache_().remove('LF:' + u);
  audit_('owner', 'مالك النظام', 'مالك النظام', 'استعادة كلمة مرور مدير النظام ' + u + ' من محرر Apps Script');
  Logger.log('اسم المستخدم: ' + u + ' — كلمة المرور المؤقتة: ' + pw + ' (غيّرها بعد الدخول من «مستخدمو النظام»)');
  return u;
}

/* ───────────── الجلسات والصلاحيات ───────────── */

function cache_() { return CacheService.getScriptCache(); }

/** انتظار القفل حتى 30 ثانية؛ عند الازدحام تُعاد المحاولة من الواجهة تلقائيًا. */
function lock_(lock) {
  if (!lock.tryLock(30000)) throw new Error('BUSY: الخادم مشغول بحفظ آخر، ستُعاد المحاولة تلقائيًا');
}

function hash_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

function secret_() {
  var p = PropertiesService.getScriptProperties(), s = p.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('AUTH_SECRET', s); }
  return s;
}

/** PBKDF2-HMAC-SHA256 (نفس اشتقاق الواجهة) — يُستخدم فقط عند استعادة كلمة المرور من المحرر. */
function pbkdf2_(pw, saltB64, iter) {
  var key = Utilities.newBlob(String(pw)).getBytes(), salt = Utilities.base64Decode(saltB64);
  var u = Utilities.computeHmacSha256Signature(salt.concat([0, 0, 0, 1]), key), t = u.slice();
  for (var i = 1; i < iter; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (var j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return Utilities.base64Encode(t);
}

function gen_(u) {
  var c = cache_(), v = null;
  try { v = c.get('G:' + u); } catch (e) { v = null; }
  if (v === null) {
    v = PropertiesService.getScriptProperties().getProperty('G_' + u) || '0';
    try { c.put('G:' + u, v, 21600); } catch (e) {}
  }
  return Number(v);
}
function bump_(u) {
  var n = String(Number(PropertiesService.getScriptProperties().getProperty('G_' + u) || 0) + 1);
  PropertiesService.getScriptProperties().setProperty('G_' + u, n);
  try { cache_().put('G:' + u, n, 21600); } catch (e) {}
}

function can_(s, perm) {
  var P = ROLE_PERMS[s.role] || [];
  if (P.indexOf('*') >= 0) return true;
  return String(perm).split('|').some(function (p) { return P.indexOf(p) >= 0; });
}

/** يتحقق من رمز الجلسة ومن صلاحية الدور؛ أي خطأ هنا يبدأ بـ AUTH فتطلب الواجهة الدخول من جديد. */
function auth_(tok, perm) {
  tok = String(tok || '');
  if (!/^[A-Za-z0-9]{24,80}$/.test(tok)) throw new Error('AUTH: انتهت الجلسة. سجّل الدخول مرة أخرى');
  var c = cache_(), raw = c.get('S:' + tok);
  if (!raw) throw new Error('AUTH: انتهت الجلسة. سجّل الدخول مرة أخرى');
  var s = JSON.parse(raw);
  if (s.g !== gen_(s.u)) { c.remove('S:' + tok); throw new Error('AUTH: تغيّرت بيانات حسابك أو صلاحياته. سجّل الدخول مرة أخرى'); }
  if (Date.now() - s.t > 600000) { s.t = Date.now(); c.put('S:' + tok, JSON.stringify(s), SESS_TTL); }
  CUR_ = s;
  if (perm && !can_(s, perm)) throw new Error('لا تملك صلاحية تنفيذ هذا الإجراء (' + s.role + ')');
  return s;
}

function editor_() {
  try {
    var a = Session.getActiveUser().getEmail(), b = Session.getEffectiveUser().getEmail();
    return !!a && a === b;
  } catch (e) { return false; }
}
function editorOnly_() { if (!editor_()) throw new Error('هذه الدالة تُشغَّل من محرر Apps Script فقط'); }

/** المهام المجدولة: تُقبل من مشغّل حقيقي في المشروع، أو من المحرر، أو من مدير نظام مسجّل. */
function trig_(e) {
  if (e && e.triggerUid) {
    try { return ScriptApp.getProjectTriggers().some(function (t) { return String(t.getUniqueId()) === String(e.triggerUid); }); } catch (x) { return false; }
  }
  if (typeof e === 'string' && e.length > 20) { try { return can_(auth_(e), '*'); } catch (x) { return false; } }
  return editor_();
}

function normU_(u) {
  u = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new Error('اسم المستخدم: 3 إلى 30 حرفًا إنجليزيًا صغيرًا أو أرقامًا');
  return u;
}

function users_() {
  var m = {};
  kvRows_().forEach(function (r) { if (r[0] === 'users') { try { m[String(r[1])] = JSON.parse(r[2]); } catch (e) {} } });
  return m;
}

function pubUser_(x) { return { u: x.u, name: x.name, role: x.role, active: x.active !== false }; }

function putUser_(x) { return kvPut_('users', x.u, JSON.stringify(x)); }

function newTok_(x) {
  var tok = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^A-Za-z0-9]/g, '');
  cache_().put('S:' + tok, JSON.stringify({ u: x.u, name: x.name, role: x.role, g: gen_(x.u), t: Date.now() }), SESS_TTL);
  return tok;
}

/** معلومات عامة قبل الدخول: هل أُنشئ حساب مدير النظام؟ */
function appInfo() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  return { users: Object.keys(users_()).length, version: VERSION, url: url };
}

/** ملح كلمة المرور؛ لاسم غير موجود يُعاد ملح ثابت مشتق، فلا يكشف النظام وجود الحساب. */
function authSalt(u) {
  u = String(u || '').trim().toLowerCase();
  var x = /^[a-z0-9._-]{3,30}$/.test(u) ? users_()[u] : null;
  if (x && x.salt) return x.salt;
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(u, secret_())).substring(0, 24);
}

function authLogin(u, h) {
  var c = cache_(), bad = { ok: false, msg: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
  u = String(u || '').trim().toLowerCase(); h = String(h || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(u) || h.length < 20 || h.length > 200) return bad;
  if (c.get('LL:' + u)) return { ok: false, msg: 'تم إيقاف المحاولات مؤقتًا بعد عدة محاولات خاطئة. حاول بعد 15 دقيقة.' };
  var x = users_()[u], good = false;
  if (x) good = x.h2 ? x.h2 === hash_(h + ':' + u) : (!!x.hash && x.hash === h);
  if (!good) {
    var n = Number(c.get('LF:' + u) || 0) + 1;
    if (n >= LOGIN_MAX) {
      c.put('LL:' + u, '1', LOCK_SEC); c.remove('LF:' + u);
      audit_(u, '', '', 'إيقاف مؤقت للحساب ' + u + ' بعد ' + LOGIN_MAX + ' محاولات دخول خاطئة');
    } else c.put('LF:' + u, String(n), LOCK_SEC);
    return bad;
  }
  if (x.active === false) return { ok: false, msg: 'هذا الحساب موقوف. راجع مدير النظام.' };
  c.remove('LF:' + u);
  if (!x.h2) { x.h2 = hash_(h + ':' + u); delete x.hash; putUser_(x); }   // لا تُحفظ قيمة الدخول نفسها
  kvPut_('activity', u, JSON.stringify({ u: u, last: new Date().toISOString() }));
  return { ok: true, tok: newTok_(x), user: pubUser_(x) };
}

function authMe(tok) {
  var s = auth_(tok), x = users_()[s.u];
  if (!x || x.active === false) throw new Error('AUTH: الحساب غير متاح');
  return pubUser_(x);
}

function authLogout(tok) {
  try { cache_().remove('S:' + String(tok || '')); } catch (e) {}
  return true;
}

/** إنشاء حساب مدير النظام الأول فقط (عندما لا يوجد أي مستخدم). */
function authSetup(o) {
  o = o || {};
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    if (Object.keys(users_()).length) throw new Error('النظام مُعدّ مسبقًا؛ سجّل الدخول بحسابك');
    var u = normU_(o.u), em = String(o.email || '').trim().toLowerCase();
    if (!o.name || String(o.name).length > 80) throw new Error('أدخل اسم الموظف');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) throw new Error('أدخل بريدًا إلكترونيًا صحيحًا');
    if (!o.salt || !o.hash || String(o.hash).length < 20) throw new Error('بيانات كلمة المرور غير صالحة');
    var x = { u: u, name: String(o.name).trim(), role: ADMIN, active: true, salt: String(o.salt), h2: hash_(String(o.hash) + ':' + u),
      eh: hash_(u + ':' + em), created: new Date().toISOString(), by: u };
    putUser_(x);
    kvPut_('private', u, JSON.stringify({ email: em, at: new Date().toISOString() }));
    kvPut_('activity', u, JSON.stringify({ u: u, last: new Date().toISOString() }));
    audit_(u, x.name, ADMIN, 'إنشاء حساب مدير النظام الأول');
    return { ok: true, tok: newTok_(x), user: pubUser_(x) };
  } finally {
    lock.releaseLock();
  }
}

/** طلب استعادة كلمة المرور: إذا طابق البريد المسجّل يُسجَّل طلب لمدير النظام. لا يكشف وجود الحساب. */
function authRecover(u, email) {
  u = String(u || '').trim().toLowerCase();
  var em = String(email || '').trim().toLowerCase(), c = cache_();
  if (!/^[a-z0-9._-]{3,30}$/.test(u) || c.get('RC:' + u)) return true;
  c.put('RC:' + u, '1', 600);
  var x = users_()[u];
  if (x && x.eh && x.eh === hash_(u + ':' + em)) {
    var cur = kvRow_('recovery', u);
    if (!cur || JSON.parse(cur).status !== 'pending') kvPut_('recovery', u, JSON.stringify({ u: u, at: new Date().toISOString(), status: 'pending' }));
  }
  return true;
}

/* ───────────── حالة النظام ───────────── */

function stGet(tok) {
  auth_(tok);
  var sh = sheet_(ss_(), SH.state, true);
  return { v: ver_(sh), json: readJson_(sh) };
}

function stVer(tok) {
  auth_(tok);
  return verC_();
}

/** استعلام خفيف كل بضع ثوانٍ: رقم إصدار البيانات + الطلبات الواردة المعلّقة (لمن يملك صلاحيتها). */
function ping(tok) {
  var s = auth_(tok), r = { v: -1 };
  try { r.v = verC_(); } catch (e) { r.v = -1; }
  if (can_(s, 'web|ord.new|approve')) {
    try {
      var c = cache_(), w = c.get('WEB');
      if (w === null) { w = JSON.stringify(webIds_()); c.put('WEB', w, 600); }
      r.w = JSON.parse(w);
    } catch (e) { /* يُعاد في الاستعلام التالي */ }
  }
  return r;
}

function verC_() {
  var c = cache_(), v = c.get('V');
  if (v === null) { v = String(ver_(sheet_(ss_(), SH.state, true))); c.put('V', v, 600); }
  return Number(v);
}

function stSave(tok, baseV, json) {
  var s = auth_(tok);
  if (typeof json !== 'string' || json.charAt(0) !== '{') throw new Error('بيانات غير صالحة');
  var obj = JSON.parse(json);
  if (!obj || typeof obj !== 'object' || !obj.inv || !Array.isArray(obj.c) || !Array.isArray(obj.o)) throw new Error('بنية البيانات غير صالحة');
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = sheet_(ss_(), SH.state, true);
    var cur = ver_(sh);
    if (Number(baseV) !== cur) {
      return { conflict: true, v: cur, json: readJson_(sh) };
    }
    var old = null;
    try { old = JSON.parse(readJson_(sh) || 'null'); } catch (e) { old = null; }
    guard_(obj, old, s);
    writeJson_(sh, json, cur + 1);
    serverLog_('حفظ', cur + 1, json.length);
    return { v: cur + 1 };
  } finally {
    lock.releaseLock();
  }
}

/**
 * حماية التحصيل على الخادم (لا تعتمد على الواجهة):
 * 1) سند القبض المسجّل لا يُعدَّل ولا يُحذف (إلا من مدير النظام عند التصفير أو الاسترجاع).
 * 2) توزيع كل سند قبض على الفواتير يساوي مبلغه تمامًا.
 * 3) لا يتجاوز مجموع المحصّل على أي فاتورة إجماليها — يمنع التحصيل المكرر لفاتورة مدفوعة والتحصيل الزائد.
 */
function guard_(nw, old, s) {
  var P = nw.p || [], adm = can_(s, '*'), r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
  var pad = function (n) { n = String(n); while (n.length < 4) n = '0' + n; return n; };
  if (old && !adm) {
    var m = {};
    P.forEach(function (p) { m[p.no] = p; });
    (old.p || []).forEach(function (q) {
      var p = m[q.no];
      if (!p || Math.abs(r2(p.a) - r2(q.a)) > 0.004 || String(p.cid) !== String(q.cid)) {
        throw new Error('GUARD: لا يمكن تعديل أو حذف سند قبض مسجّل (RCT-' + pad(q.no) + ')');
      }
    });
  }
  if (old && !adm) {
    ['c', 'o', 'pf', 'iv', 'p', 'dp', 'pu', 'x', 'sp', 'van', 'vd', 'dc'].forEach(function (k) {
      var key = k === 'c' || k === 'o' ? 'id' : 'no', have = {};
      (nw[k] || []).forEach(function (r) { if (r) have[r[key]] = 1; });
      (old[k] || []).forEach(function (r) {
        if (r && r[key] != null && !have[r[key]]) throw new Error('GUARD: لا يمكن حذف سجلات محفوظة (' + k + ' #' + r[key] + '). الحذف والتصفير لمدير النظام فقط');
      });
    });
  }
  P.forEach(function (p) {
    if (!p.al) return;
    if (!Array.isArray(p.al) || p.al.some(function (x) { return !(Number(x.a) > 0); })) throw new Error('GUARD: توزيع سند القبض غير صالح');
    var t = p.al.reduce(function (a, x) { return a + Number(x.a); }, 0);
    if (Math.abs(r2(t) - r2(p.a)) > 0.01) throw new Error('GUARD: مبلغ سند القبض لا يطابق توزيعه على الفواتير');
  });
  // طلب العميل الوارد يُقبل مرة واحدة فقط (يمنع التكرار عند قبوله من مستخدمين في نفس الوقت)
  var wc = function (st) { var m = {}; (st && st.o || []).forEach(function (o) { if (o && o.web && o.s !== 'x') m[o.web] = (m[o.web] || 0) + 1; }); return m; };
  var W1 = wc(nw), W0 = wc(old);
  Object.keys(W1).forEach(function (k) {
    if (W1[k] > 1 && W1[k] > (W0[k] || 0)) throw new Error('GUARD: طلب العميل ' + k + ' مقبول مسبقًا كطلب آخر؛ لا يُقبل مرتين');
  });
  var A = alloc_(nw), A0 = alloc_(old || {});
  (nw.iv || []).forEach(function (v) {
    var a = r2(A[v.no] || 0);
    if (a > r2(v.total) + 0.01 && Math.abs(a - r2(A0[v.no] || 0)) > 0.004) {
      throw new Error('GUARD: تحصيل مكرر أو أكبر من المتبقي على الفاتورة INV-' + pad(v.no) + ' (المحصّل ' + a.toFixed(2) + ' من ' + r2(v.total).toFixed(2) + ')');
    }
  });
}

function alloc_(st) {
  var m = {}, byO = {};
  (st.iv || []).forEach(function (v) { byO[v.oid] = v.no; });
  (st.p || []).forEach(function (p) {
    if (Array.isArray(p.al)) p.al.forEach(function (x) { m[x.i] = (m[x.i] || 0) + Number(x.a); });
    else if (p.inv) m[p.inv] = (m[p.inv] || 0) + Number(p.a);
    else if (p.o && byO[p.o]) m[byO[p.o]] = (m[byO[p.o]] || 0) + Number(p.a);
  });
  return m;
}

/* ───────────── المستخدمون والسجلات ───────────── */

function kvList(tok, col) {
  var s = auth_(tok), adm = can_(s, '*');
  if (col === 'audit') { if (!adm) throw new Error('لا تملك صلاحية عرض سجل التدقيق'); return auditList_(100000); }
  checkCol_(col);
  var rows = kvRows_().filter(function (r) { return r[0] === col; });
  if (col === 'users') {
    return rows.map(function (r) {
      var x = JSON.parse(r[2]), o = pubUser_(x);
      if (adm) { o.eh = !!x.eh; o.created = x.created || ''; o.pwAt = x.pwAt || ''; }
      return { id: String(r[1]), json: JSON.stringify(o) };
    });
  }
  if (!adm) return [];
  return rows.map(function (r) { return { id: String(r[1]), json: String(r[2]) }; });
}

function kvGet(tok, col, id) {
  var s = auth_(tok);
  checkCol_(col);
  if (col === 'users') { var x = users_()[String(id)]; return x ? JSON.stringify(pubUser_(x)) : null; }
  if (!can_(s, '*')) return null;
  return kvRow_(col, id);
}

function kvSet(tok, col, id, json) {
  var s = auth_(tok);
  checkCol_(col);
  checkId_(id);
  var o = JSON.parse(json);
  if (col === 'activity') {
    if (String(id) !== s.u) throw new Error('لا يمكن تعديل نشاط مستخدم آخر');
    return kvPut_('activity', s.u, JSON.stringify({ u: s.u, last: new Date().toISOString() }));
  }
  if (!can_(s, '*')) throw new Error('إدارة المستخدمين لمدير النظام فقط');
  if (col === 'users') return userPut_(s, String(id).toLowerCase(), o);
  if (col === 'private') {
    var em = String(o.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) throw new Error('صيغة البريد الإلكتروني غير صحيحة');
    var all = users_(), x = all[String(id)];
    if (x) { x.eh = hash_(x.u + ':' + em); putUser_(x); }
    return kvPut_('private', id, JSON.stringify({ email: em, at: new Date().toISOString() }));
  }
  return kvPut_(col, id, json);
}

/** إضافة أو تعديل مستخدم (لمدير النظام): كلمة المرور تصل مشتقة من الواجهة ولا تُحفظ إلا بعد تجزئتها مرة أخرى. */
function userPut_(s, u, o) {
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var all = users_(), old = all[u], x = old ? JSON.parse(JSON.stringify(old)) : null;
    if (!x) {
      normU_(u);
      if (!o.salt || !o.hash) throw new Error('كلمة المرور مطلوبة للمستخدم الجديد');
      x = { u: u, active: true, created: new Date().toISOString(), by: s.u };
    }
    if (o.name) x.name = String(o.name).trim().substring(0, 80);
    if (!x.name) throw new Error('أدخل اسم الموظف');
    if (o.role) { if (!ROLE_PERMS[o.role]) throw new Error('دور غير معروف'); x.role = o.role; }
    if (!x.role) x.role = 'المبيعات';
    if (typeof o.active === 'boolean') x.active = o.active;
    if (o.salt && o.hash) {
      if (String(o.hash).length < 20) throw new Error('بيانات كلمة المرور غير صالحة');
      x.salt = String(o.salt); x.h2 = hash_(String(o.hash) + ':' + u); delete x.hash;
      x.pwAt = new Date().toISOString(); x.pwBy = s.u;
      cache_().remove('LL:' + u); cache_().remove('LF:' + u);
    }
    if (typeof o.eh === 'string' && o.eh.length > 20) x.eh = o.eh;
    x.upd = new Date().toISOString(); x.updBy = s.u;
    if (u === s.u && x.active === false) throw new Error('لا يمكنك إيقاف حسابك الحالي');
    var others = Object.keys(all).filter(function (k) { return k !== u && all[k].active !== false && all[k].role === ADMIN; });
    if (!others.length && (x.role !== ADMIN || x.active === false)) throw new Error('لا يمكن إزالة أو إيقاف آخر مدير نظام نشط');
    putUser_(x);
    if (old && (old.role !== x.role || (old.active !== false) !== (x.active !== false) || (o.salt && o.hash))) bump_(u);
    serverLog_((old ? 'تعديل' : 'إضافة') + ' مستخدم ' + u, '', 0);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** حذف مستخدم نهائيًا (لمدير النظام). سجل التدقيق يبقى كما هو. */
function userDel(tok, u) {
  var s = auth_(tok, '*');
  u = normU_(u);
  if (u === s.u) throw new Error('لا يمكنك حذف حسابك الحالي');
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var all = users_();
    if (!all[u]) throw new Error('المستخدم غير موجود');
    var others = Object.keys(all).filter(function (k) { return k !== u && all[k].active !== false && all[k].role === ADMIN; });
    if (all[u].role === ADMIN && !others.length) throw new Error('لا يمكن حذف آخر مدير نظام نشط');
    var sh = sheet_(ss_(), SH.kv, true), rows = kvRows_(sh);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][1]) === u && KV_COLS.indexOf(rows[i][0]) >= 0) sh.deleteRow(i + 1);
    }
    bump_(u);
    audit_(s.u, s.name, s.role, 'حذف المستخدم ' + u + ' (' + (all[u].name || '') + ' — ' + all[u].role + ')');
    return true;
  } finally {
    lock.releaseLock();
  }
}

function kvDel(tok, col, id) {
  auth_(tok, '*');
  checkCol_(col);
  if (col === 'users') return userDel(tok, id);
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = sheet_(ss_(), SH.kv, true);
    var rows = kvRows_(sh);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] === col && String(rows[i][1]) === String(id)) sh.deleteRow(i + 1);
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

function kvRow_(col, id) {
  var r = kvRows_().filter(function (x) { return x[0] === col && String(x[1]) === String(id); })[0];
  return r ? String(r[2]) : null;
}

function kvPut_(col, id, json) {
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = sheet_(ss_(), SH.kv, true);
    var rows = kvRows_(sh);
    var now = new Date().toISOString();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === col && String(rows[i][1]) === String(id)) {
        sh.getRange(i + 1, 1, 1, 4).setNumberFormat('@').setValues([[col, String(id), json, now]]);
        return true;
      }
    }
    var n = sh.getLastRow() + 1;
    sh.getRange(n, 1, 1, 4).setNumberFormat('@').setValues([[col, String(id), json, now]]);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** يُضاف إلى سجل التدقيق فقط؛ هوية المستخدم من الجلسة على الخادم لا من الواجهة. */
function auditAdd(tok, json) {
  var s = auth_(tok), o = JSON.parse(json);
  audit_(s.u, s.name, s.role, o.m);
  return true;
}

function audit_(u, n, r, m) {
  sheet_(ss_(), SH.audit, false).appendRow([new Date().toISOString(), clip_(u), clip_(n), clip_(r), clip_(m, 2000), 'التطبيق']);
}

function auditList(tok, limit) {
  auth_(tok, '*');
  return auditList_(Math.min(Number(limit) || 300, 5000));
}

/** في هذه النسخة «المالك» هو مدير النظام المسجّل. */
function isOwner(tok) {
  try { return can_(auth_(tok), '*'); } catch (e) { return false; }
}

/* ───────────── النسخة المقروءة والنسخ الاحتياطي ───────────── */

function mirror(e) {
  if (!trig_(e)) throw new Error('غير مسموح');
  return track_('mirror', mirror_);
}

function mirror_() {
  var ss = ss_();
  var st = JSON.parse(readJson_(sheet_(ss, SH.state, true)) || '{}');
  MIRROR.forEach(function (m) {
    var arr = Array.isArray(st[m[0]]) ? st[m[0]] : [];
    var sh = sheet_(ss, m[1], false);
    sh.clearContents();
    sh.setRightToLeft(true);
    if (!arr.length) { sh.getRange(1, 1).setValue('لا توجد بيانات'); return; }
    var keys = [];
    arr.forEach(function (r) { Object.keys(r || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    var rows = arr.map(function (r) {
      return keys.map(function (k) {
        var v = r ? r[k] : '';
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') return clip_(JSON.stringify(v), 45000);
        if (typeof v === 'string') return clip_(v, 45000);
        return v;
      });
    });
    sh.getRange(1, 1, 1, keys.length).setValues([keys]).setFontWeight('bold');
    sh.getRange(2, 1, rows.length, keys.length).setValues(rows);
    sh.setFrozenRows(1);
  });
  var inv = sheet_(ss, 'ملخص المخزون', false);
  inv.clearContents();
  inv.setRightToLeft(true);
  var i = st.inv || {}, held = (st.c || []).reduce(function (a, c) { return a + (Number(c.h) || 0); }, 0);
  inv.getRange(1, 1, 8, 2).setValues([
    ['البند (عبوات 18.9 لتر)', 'القيمة'], ['ممتلئة في المستودع', i.full || 0], ['فارغة في المستودع', i.empty || 0],
    ['في عهدة المناديب', i.rep || 0], ['لدى المصنع للتعبئة', i.fac || 0], ['لدى العملاء (أمانة)', held],
    ['تالفة / مفقودة', i.dmg || 0], ['آخر تحديث', new Date()]
  ]);
}

/** المهمة المجدولة تمرّر كائن حدث؛ يُقبل من مشغّل حقيقي أو من المحرر فقط. */
function backup(e) {
  if (!trig_(e)) throw new Error('غير مسموح');
  return track_('backup', function () { return backup_(''); });
}

function backup_(tag) {
  var ss = ss_();
  var payload = JSON.stringify({
    at: new Date().toISOString(),
    version: ver_(sheet_(ss, SH.state, true)),
    app: VERSION,
    state: JSON.parse(readJson_(sheet_(ss, SH.state, true)) || 'null'),
    kv: kvRows_().map(function (r) { return { col: r[0], id: r[1], data: JSON.parse(r[2]) }; }),
    audit: auditList_(100000)
  });
  var folder = backupFolder_();
  var name = 'maizain-backup-' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM-dd_HHmmss') + (tag ? '-' + tag : '') + '.json';
  var file = folder.createFile(name, payload, 'application/json');
  // التحقق من سلامة النسخة بعد حفظها: إعادة قراءتها ومطابقة الحجم والبنية
  try {
    var back = file.getBlob().getDataAsString('UTF-8');
    var o = JSON.parse(back);
    if (back.length !== payload.length || !('state' in o)) throw new Error('size/shape');
  } catch (e) {
    serverLog_('تحذير: النسخة الاحتياطية ' + name + ' لم تجتز التحقق', '', payload.length);
    throw new Error('فشل التحقق من النسخة الاحتياطية');
  }
  var files = [];
  var fi = folder.getFiles();
  while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  serverLog_('نسخة احتياطية ' + name, '', payload.length);
  return name;
}

function backupFolder_() {
  var it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

function backupNow(tok) {
  auth_(tok, '*');
  return track_('backup', function () { return backup_(''); });
}

function backupList(tok) {
  auth_(tok, '*');
  return backupList_();
}

function backupList_() {
  var out = [], fi = backupFolder_().getFiles();
  while (fi.hasNext()) {
    var f = fi.next();
    out.push({ id: f.getId(), name: f.getName(), at: new Date(f.getDateCreated()).toISOString(), size: f.getSize() });
  }
  out.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  return out;
}

function backupFile_(id) {
  var f = DriveApp.getFileById(String(id)), ok = false, ps = f.getParents();
  while (ps.hasNext()) if (ps.next().getName() === BACKUP_FOLDER) ok = true;
  if (!ok) throw new Error('الملف ليس من مجلد النسخ الاحتياطية');
  return f;
}

function backupParse_(text) {
  var o;
  try { o = JSON.parse(text); } catch (e) { throw new Error('الملف تالف أو ليس نسخة احتياطية صالحة'); }
  var st = o && o.state ? o.state : (o && o.inv ? o : null);
  if (!st || !st.inv || !Array.isArray(st.c) || !Array.isArray(st.o)) throw new Error('الملف لا يحتوي بيانات النظام');
  return { o: o, st: st };
}

function backupSummary_(o, st) {
  var users = (o.kv || []).filter(function (r) { return r.col === 'users'; }).length;
  return {
    at: o.at || '', version: o.version || 0, customers: st.c.length, orders: st.o.length,
    invoices: (st.iv || []).length, vouchers: (st.dp || []).length, expenses: (st.x || []).length,
    payments: (st.p || []).length, users: users, audit: (o.audit || []).length, hasUsers: users > 0
  };
}

function backupInfo(tok, id) {
  auth_(tok, '*');
  var f = backupFile_(id), b = backupParse_(f.getBlob().getDataAsString('UTF-8'));
  var s = backupSummary_(b.o, b.st);
  s.name = f.getName();
  return s;
}

function backupRestore(tok, id, withUsers) {
  var s = auth_(tok, '*'), f = backupFile_(id);
  return restore_(s, f.getBlob().getDataAsString('UTF-8'), withUsers, f.getName());
}

function backupRestoreJson(tok, text, withUsers) {
  var s = auth_(tok, '*');
  return restore_(s, String(text), withUsers, 'ملف مرفوع');
}

function restore_(s, text, withUsers, src) {
  var b = backupParse_(text);
  if (withUsers && !(b.o.kv || []).some(function (r) { return r.col === 'users'; })) throw new Error('النسخة لا تحتوي حسابات المستخدمين');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var pre = track_('backup', function () { return backup_('before-restore'); });
    var sh = sheet_(ss_(), SH.state, true), v = ver_(sh) + 1;
    writeJson_(sh, JSON.stringify(b.st), v);
    if (withUsers) {
      var kv = sheet_(ss_(), SH.kv, true);
      kv.clearContents();
      var rows = b.o.kv.map(function (r) { return [r.col, String(r.id), JSON.stringify(r.data), new Date().toISOString()]; });
      if (rows.length) kv.getRange(1, 1, rows.length, 4).setValues(rows);
      Object.keys(users_()).forEach(bump_);
    }
    audit_(s.u, s.name, s.role, 'استرجاع نسخة احتياطية: ' + src + (withUsers ? ' (مع المستخدمين)' : '') + '؛ حُفظت نسخة الوضع السابق: ' + pre);
    serverLog_('استرجاع: ' + src, v, text.length);
    var sm = backupSummary_(b.o, b.st);
    sm.v = v; sm.pre = pre;
    return sm;
  } finally {
    lock.releaseLock();
  }
}

/**
 * استيراد بيانات النموذج القديم: ضع ملفًا باسم maizain_import.json في Drive
 * يحتوي ناتج localStorage.getItem("maizain_v1") ثم شغّل هذه الدالة من المحرر.
 */
function importFromDrive() {
  editorOnly_();
  var it = DriveApp.getFilesByName('maizain_import.json');
  if (!it.hasNext()) throw new Error('لم يُعثر على الملف maizain_import.json في Drive');
  var json = it.next().getBlob().getDataAsString('UTF-8').trim();
  var obj = JSON.parse(json);
  if (!obj || !obj.inv) throw new Error('الملف لا يحتوي بيانات النظام');
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = sheet_(ss_(), SH.state, true);
    var cur = ver_(sh);
    if (cur > 0) backup_('before-import');
    writeJson_(sh, JSON.stringify(obj), cur + 1);
    serverLog_('استيراد من Drive', cur + 1, json.length);
  } finally {
    lock.releaseLock();
  }
  mirror_();
  return 'تم الاستيراد';
}

/* ───────────── المرفقات (فواتير الموردين، المصروفات، صور إثبات التسليم) ───────────── */

var ATT_FOLDER = 'MAI ZAIN — مرفقات المصروفات';
var ATT_MAX = 10 * 1024 * 1024;

function attPut(tok, name, mime, b64) {
  auth_(tok);
  if (!/^(application\/pdf|image\/(png|jpe?g|gif|webp|heic|heif))$/.test(String(mime))) throw new Error('نوع الملف غير مسموح');
  var bytes = Utilities.base64Decode(String(b64));
  if (bytes.length > ATT_MAX) throw new Error('الملف أكبر من 10 ميجابايت');
  name = String(name || 'attachment').replace(/[\\/:*?"<>|]/g, '_').substring(0, 120);
  var it = DriveApp.getFoldersByName(ATT_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(ATT_FOLDER);
  var file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  serverLog_('مرفق: ' + name, '', bytes.length);
  return { id: file.getId(), url: '', name: name };
}

/** عرض المرفق للموظف المسجّل عبر الخادم (الموظفون بلا حسابات Google). */
function attGet(tok, id) {
  auth_(tok);
  var f = DriveApp.getFileById(String(id)), ok = false, ps = f.getParents();
  while (ps.hasNext()) { var n = ps.next().getName(); if (n === ATT_FOLDER || n === DOC_FOLDER) ok = true; }
  if (!ok) throw new Error('الملف ليس من مرفقات النظام');
  var b = f.getBlob();
  return { name: f.getName(), mime: b.getContentType(), b64: Utilities.base64Encode(b.getBytes()) };
}

/* ───────────── مستندات العملاء (PDF لواتساب) ───────────── */

var DOC_FOLDER = 'MAI ZAIN — مستندات العملاء';

/** يحفظ ملف PDF ويعيد رابط عرض لمن يملك الرابط (لإرساله للعميل عبر واتساب). */
function pdfPut(tok, name, b64) {
  auth_(tok);
  var bytes = Utilities.base64Decode(String(b64));
  if (bytes.length > ATT_MAX) throw new Error('الملف أكبر من 10 ميجابايت');
  name = String(name || 'document.pdf').replace(/[\\/:*?"<>|]/g, '_').substring(0, 120);
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  var it = DriveApp.getFoldersByName(DOC_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(DOC_FOLDER);
  var file = folder.createFile(Utilities.newBlob(bytes, 'application/pdf', name));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    file.setTrashed(true);
    throw new Error('مشاركة الروابط خارج الشركة محظورة في إعدادات Google Workspace؛ استخدم مشاركة الملف أو التنزيل');
  }
  serverLog_('مستند للعميل: ' + name, '', bytes.length);
  return file.getUrl();
}

/* ───────────── مواقع العملاء على الخريطة ───────────── */

/** يستخرج الإحداثيات من رابط خرائط Google (ومنها الروابط المختصرة) أو من العنوان. */
function geoLink(tok, url, addr) {
  auth_(tok);
  var u = String(url || '').trim(), ll = ll_(u);
  if (!ll && /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/|maps\.google\.|www\.google\.[a-z.]+\/maps)/.test(u)) {
    try {
      var next = u;
      for (var i = 0; i < 3 && !ll && next; i++) {
        var r = UrlFetchApp.fetch(next, { followRedirects: false, muteHttpExceptions: true }), h = r.getHeaders() || {};
        var loc = h.Location || h.location || '';
        ll = ll_(loc) || ll_(next);
        if (!ll && !loc) ll = ll_(String(r.getContentText() || '').substring(0, 30000));
        next = loc;
      }
    } catch (e) { /* الرابط غير متاح */ }
  }
  if (!ll && addr) {
    try {
      var g = Maps.newGeocoder().setRegion('ae').geocode(String(addr).substring(0, 300));
      if (g && g.status === 'OK' && g.results && g.results.length) {
        var p = g.results[0].geometry.location;
        ll = inUAE_(p.lat, p.lng) ? { lat: p.lat, lng: p.lng, src: 'address' } : null;
      }
    } catch (e) { /* خدمة الخرائط غير متاحة */ }
  }
  return ll;
}

function ll_(s) {
  try { s = decodeURIComponent(String(s || '')); } catch (e) { s = String(s || ''); }
  var m = s.match(/@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/) || s.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
    s.match(/[?&](?:q|query|ll|destination|daddr|center)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/) ||
    s.match(/^\s*(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})\s*$/);
  if (!m) return null;
  var lat = Number(m[1]), lng = Number(m[2]);
  return inUAE_(lat, lng) ? { lat: lat, lng: lng } : null;
}

function inUAE_(lat, lng) { return lat >= 22 && lat <= 27 && lng >= 51 && lng <= 57; }

/* ───────────── التقرير اليومي بالبريد ───────────── */

function dailyReport(e) {
  if (!trig_(e)) throw new Error('غير مسموح');
  return track_('report', dailyReport_);
}

function dailyReport_() {
  var ss = ss_();
  var st = JSON.parse(readJson_(sheet_(ss, SH.state, true)) || 'null');
  if (!st) return 'لا توجد بيانات';
  var T = Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM-dd');
  var sum = function (a, fn) { return (a || []).reduce(function (t, x) { return t + (Number(fn(x)) || 0); }, 0); };
  var f = function (n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); };
  var O = st.o || [], P = st.p || [], X = st.x || [], C = st.c || [], IV = st.iv || [], DP = st.dp || [], SP = st.sp || [];
  var del = O.filter(function (o) { return o.s === 'd' && (o.dd || o.d) === T; });
  var open = O.filter(function (o) { return 'ncr'.indexOf(o.s) >= 0; });
  var late = open.filter(function (o) { return o.d < T; });
  var items = function (o) { return o.items && o.items.length ? o.items : [{ pid: o.pid || 1, q: o.q || 0 }]; };
  var reserved = sum(O.filter(function (o) { return 'nc'.indexOf(o.s) >= 0; }), function (o) {
    return sum(items(o).filter(function (i) { return (i.pid || 1) == 1; }), function (i) { return i.q; });
  });
  var avail = ((st.inv || {}).full || 0) + ((st.inv || {}).rep || 0) - reserved;
  var low = (st.pr || []).filter(function (p) { return p.qty <= (p.min || 0); }).map(function (p) { return p.name + ' (' + p.qty + ')'; });
  var paidOf = alloc_(st);
  var unpaid = IV.filter(function (v) { return v.total - (paidOf[v.no] || 0) > 0.004; });
  var overdue = unpaid.filter(function (v) { return v.due < T; });
  var blk = {};
  unpaid.forEach(function (v) { blk[v.cid] = (blk[v.cid] || 0) + 1; });
  var blocked = C.filter(function (c) { return (blk[c.id] || 0) > 7; }).map(function (c) { return c.name; });
  var dpCat = function (v) { if (v.t !== 'c') return v.t; var o = DP.filter(function (x) { return x.no == v.ref; })[0]; return o ? o.t : 'd'; };
  var dpAmt = function (L, t) { return sum(L.filter(function (v) { return dpCat(v) === t; }), function (v) { return (v.t === 'c' ? -1 : 1) * v.a; }); };
  var dpToday = DP.filter(function (v) { return v.d === T; });
  var closed = (st.cl || []).filter(function (c) { return c.d === T; })[0];
  var vd = (st.vd || []).filter(function (x) { return x.d === T; });
  var rows = [
    ['طلبات اليوم', 'Orders today', O.filter(function (o) { return o.d === T; }).length],
    ['سُلّمت اليوم', 'Delivered today', del.length],
    ['مبيعات مسلّمة (د.إ)', 'Delivered sales (AED)', f(sum(del, function (o) { return o.t; }))],
    ['التحصيل (د.إ)', 'Collections (AED)', f(sum(P.filter(function (p) { return p.d === T; }), function (p) { return p.a; }))],
    ['المصروفات التشغيلية (د.إ)', 'Operating expenses (AED)', f(sum(X.filter(function (x) { return x.d === T && !x.pu; }), function (x) { return x.a; }))],
    ['سداد فواتير الموردين (د.إ)', 'Supplier payments (AED)', f(sum(SP.filter(function (x) { return x.d === T; }), function (x) { return x.a; }) + sum(X.filter(function (x) { return x.d === T && x.pu; }), function (x) { return x.a; }))],
    ['طلبات مفتوحة / متأخرة', 'Open / late orders', open.length + ' / ' + late.length],
    ['ذمم العملاء (د.إ)', 'Receivables (AED)', f(sum(C, function (c) { return c.bal; }))],
    ['فواتير متأخرة', 'Overdue invoices', overdue.length],
    ['عملاء محظورون (أكثر من 7 فواتير غير مسددة)', 'Blocked customers', blocked.length ? blocked.length + ' — ' + blocked.slice(0, 5).join('، ') : 0],
    ['عبوات ممتلئة متاحة', 'Full bottles available', avail + (avail < (st.min || 0) ? ' ⚠' : '')],
    ['فروقات عهدة المناديب اليوم', 'Van stock variances today', vd.length ? vd.length + ' (' + f(sum(vd, function (x) { return x.val; })) + ' د.إ)' : 0],
    ['أمانات التأمين اليوم: مستلم / مردود (د.إ)', 'Deposits today: in / out (AED)', f(dpAmt(dpToday, 'd')) + ' / ' + f(dpAmt(dpToday, 'r'))],
    ['رصيد أمانات التأمين (د.إ)', 'Deposit balance (AED)', f(dpAmt(DP, 'd') - dpAmt(DP, 'r'))],
    ['إقفال اليوم', 'Day closed', closed ? ('نعم / Yes' + (closed.diff ? ' — فرق ' + f(closed.diff) : '')) : 'لا / No'],
    ['أعطال النظام اليوم', 'System errors today', errToday_(T)],
    ['طلبات العملاء بانتظار القبول', 'Customer orders waiting', webPending_()]
  ];
  var warn = healthWarnings_();
  var html = '<div style="font-family:Arial,sans-serif;max-width:640px">' +
    '<h2 style="color:#0057b8;margin:0 0 4px">MAI ZAIN — التقرير اليومي / Daily Report</h2><div style="color:#4a6283">' + T + '</div>' +
    '<table style="border-collapse:collapse;width:100%;margin-top:12px">' + rows.map(function (r, i) {
      return '<tr style="background:' + (i % 2 ? '#fff' : '#eaf7ff') + '"><td style="padding:7px;direction:rtl;text-align:right">' + r[0] + '</td><td style="padding:7px;color:#4a6283">' + r[1] + '</td><td style="padding:7px;font-weight:bold;text-align:right">' + r[2] + '</td></tr>';
    }).join('') + '</table>' +
    (low.length ? '<p style="color:#c62828">أصناف عند الحد الأدنى / Low stock: ' + low.join('، ') + '</p>' : '') +
    (late.length ? '<p style="color:#c62828">طلبات متأخرة / Late orders: ' + late.map(function (o) { return '#' + o.id; }).join(', ') + '</p>' : '') +
    (warn.length ? '<p style="color:#c62828">تنبيه صحة النظام / System health: ' + warn.join(' — ') + '</p>' : '') +
    '<p style="color:#4a6283;font-size:12px">أُرسل تلقائيًا من نظام MAI ZAIN. للتفاصيل افتح النظام. / Sent automatically by the MAI ZAIN system.</p></div>';
  var to = reportRecipients_();
  if (!to.length) {
    serverLog_('تقرير يومي: لا يوجد مستلم', '', 0);
    errAdd_('الخادم: التقرير اليومي', 'لا يوجد بريد لمدير النظام أو المدير العام', '');
    return 'لا يوجد بريد لمدير النظام أو المدير العام';
  }
  MailApp.sendEmail({ to: to.join(','), subject: 'MAI ZAIN — التقرير اليومي / Daily Report — ' + T, htmlBody: html });
  serverLog_('تقرير يومي إلى ' + to.join(','), '', html.length);
  return 'أُرسل إلى ' + to.join(', ');
}

function reportRecipients_() {
  var rows = kvRows_(), users = {}, mails = {};
  rows.forEach(function (r) {
    try {
      var d = JSON.parse(r[2]);
      if (r[0] === 'users') users[r[1]] = d;
      if (r[0] === 'private' && d.email) mails[r[1]] = d.email;
    } catch (e) {}
  });
  return Object.keys(users).filter(function (u) {
    var x = users[u];
    return x.active !== false && (x.role === 'مدير النظام' || x.role === 'المدير العام') && mails[u];
  }).map(function (u) { return mails[u]; });
}

/* ───────────── التقرير الشهري بالبريد (أول كل شهر) ───────────── */

function monthlyReport(e) {
  if (!trig_(e)) throw new Error('غير مسموح');
  return track_('monthly', function () { return monthlyReport_(); });
}

function monthlyNow(tok) {
  auth_(tok, '*');
  return track_('monthly', function () { return monthlyReport_(); });
}

function monthlyReport_(ym) {
  var st = JSON.parse(readJson_(sheet_(ss_(), SH.state, true)) || 'null');
  if (!st) return 'لا توجد بيانات';
  var now = Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM');
  var prevM = function (m) { var y = Number(m.slice(0, 4)), mm = Number(m.slice(5, 7)) - 1; if (mm < 1) { mm = 12; y--; } return y + '-' + (mm < 10 ? '0' : '') + mm; };
  ym = ym || prevM(now);
  var pm = prevM(ym);
  var sum = function (a, fn) { return (a || []).reduce(function (t, x) { return t + (Number(fn(x)) || 0); }, 0); };
  var f0 = function (n) { return Math.round(Number(n) || 0).toLocaleString('en'); };
  var C = {};
  (st.c || []).forEach(function (c) { C[c.id] = c; });
  var agg = function (m) {
    var D = (st.o || []).filter(function (o) { return o.s === 'd' && String(o.dd || o.d).slice(0, 7) === m; });
    var by = function (fn) { var r = {}; D.forEach(function (o) { var k = fn(o) || '—'; r[k] = (r[k] || 0) + (Number(o.t) || 0); }); return r; };
    var bq = function (o) { return sum((o.items && o.items.length ? o.items : [{ pid: o.pid || 1, q: o.q || 0 }]).filter(function (i) { return (i.pid || 1) == 1; }), function (i) { return i.q; }); };
    return {
      sales: sum(D, function (o) { return o.t; }), n: D.length, bottles: sum(D, bq),
      col: sum((st.p || []).filter(function (p) { return String(p.d).slice(0, 7) === m; }), function (p) { return p.a; }),
      exp: sum((st.x || []).filter(function (x) { return String(x.d).slice(0, 7) === m && !x.pu; }), function (x) { return x.a; }),
      newC: (st.c || []).filter(function (c) { return String(c.d || '').slice(0, 7) === m; }).length,
      area: by(function (o) { var c = C[o.cid] || {}; return (c.em || 'عجمان') + ' — ' + (c.area || '—'); }),
      type: by(function (o) { return (C[o.cid] || {}).type; }),
      cust: by(function (o) { return (C[o.cid] || {}).name; }),
      drv: by(function (o) { return o.rep || 'بدون مندوب'; })
    };
  };
  var a = agg(ym), b = agg(pm);
  var ch = function (x, y) { if (!y) return x ? '<span style="color:#2e7d32">جديد</span>' : '—'; var p = Math.round((x - y) / y * 100); return '<span style="color:' + (p >= 0 ? '#2e7d32' : '#c62828') + '">' + (p >= 0 ? '+' : '') + p + '%</span>'; };
  var bars = function (title, o, n) {
    var e = Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (x, y) { return y[1] - x[1]; }).slice(0, n || 8);
    var mx = e.length ? e[0][1] : 1;
    return '<h3 style="color:#0057b8;margin:18px 0 6px">' + title + '</h3>' + (e.length ? '<table style="width:100%;border-collapse:collapse">' + e.map(function (r) {
      return '<tr><td style="padding:4px;width:38%;direction:rtl;text-align:right">' + r[0] + '</td><td style="padding:4px"><div style="background:#00aeef;height:14px;border-radius:4px;width:' + Math.max(2, Math.round(r[1] / (mx || 1) * 100)) + '%"></div></td><td style="padding:4px;text-align:right;white-space:nowrap">' + f0(r[1]) + '</td></tr>';
    }).join('') + '</table>' : '<p style="color:#4a6283">لا توجد بيانات</p>');
  };
  var row = function (l, x, y) { return '<tr><td style="padding:7px;direction:rtl;text-align:right">' + l + '</td><td style="padding:7px;font-weight:bold">' + f0(x) + '</td><td style="padding:7px;color:#4a6283">' + f0(y) + '</td><td style="padding:7px">' + ch(x, y) + '</td></tr>'; };
  var html = '<div style="font-family:Arial,sans-serif;max-width:680px">' +
    '<h2 style="color:#0057b8;margin:0 0 4px">MAI ZAIN — التقرير الشهري / Monthly Report</h2><div style="color:#4a6283">' + ym + ' مقارنة بـ ' + pm + '</div>' +
    '<table style="border-collapse:collapse;width:100%;margin-top:12px"><tr style="background:#0b2d5b;color:#fff"><th style="padding:7px;text-align:right">البند</th><th style="padding:7px">' + ym + '</th><th style="padding:7px">' + pm + '</th><th style="padding:7px">التغير</th></tr>' +
    row('المبيعات المسلّمة (د.إ)', a.sales, b.sales) + row('عدد الطلبات المسلّمة', a.n, b.n) + row('عبوات 18.9 لتر المسلّمة', a.bottles, b.bottles) +
    row('التحصيل (د.إ)', a.col, b.col) + row('المصروفات التشغيلية (د.إ)', a.exp, b.exp) + row('عملاء جدد', a.newC, b.newC) + '</table>' +
    bars('المبيعات حسب المنطقة (د.إ)', a.area) + bars('المبيعات حسب نوع العميل (د.إ)', a.type) + bars('أكبر 10 عملاء (د.إ)', a.cust, 10) + bars('المبيعات حسب المندوب (د.إ)', a.drv) +
    '<p style="color:#4a6283;font-size:12px">أُرسل تلقائيًا من نظام MAI ZAIN في أول كل شهر. / Sent automatically on the 1st of each month.</p></div>';
  var to = reportRecipients_();
  if (!to.length) return 'لا يوجد بريد لمدير النظام أو المدير العام';
  MailApp.sendEmail({ to: to.join(','), subject: 'MAI ZAIN — التقرير الشهري / Monthly Report — ' + ym, htmlBody: html });
  serverLog_('تقرير شهري ' + ym + ' إلى ' + to.join(','), '', html.length);
  return 'أُرسل تقرير ' + ym + ' إلى ' + to.join(', ');
}

/* ───────────── سجل الأعطال وصحة النظام ───────────── */

/** يسجّل عطلًا أرسله جهاز موظف (إضافة فقط). يُقبل قبل الدخول بحد أقصى للمعدل. */
function errLog(tok, json) {
  var s = null;
  try { s = tok ? auth_(tok) : null; } catch (e) { s = null; }
  if (!s) {
    var c = cache_(), n = Number(c.get('EL') || 0) + 1;
    if (n > 30) return false;
    c.put('EL', String(n), 60);
  }
  var o = JSON.parse(String(json));
  errSheet_(ss_()).appendRow([
    String(o.ts || new Date().toISOString()).substring(0, 40), s ? s.u : 'قبل الدخول', clip_(s ? s.u : o.u, 80), clip_(s ? s.name : o.n, 120), clip_(s ? s.role : o.r, 60),
    clip_(o.src || 'الواجهة', 120), clip_(o.m, 500), clip_(o.d, 1500), clip_(o.v, 40), clip_(o.ua, 200)
  ]);
  return true;
}

/** يعلّم كل الأعطال الحالية بأنها رُوجعت (لا يحذف شيئًا). */
function errSeen(tok) {
  auth_(tok, '*');
  PropertiesService.getScriptProperties().setProperty('ERR_SEEN', new Date().toISOString());
  serverLog_('مراجعة سجل الأعطال', '', 0);
  return true;
}

function health(tok) {
  auth_(tok, '*');
  var ss = ss_(), props = PropertiesService.getScriptProperties();
  var cells = 0;
  ss.getSheets().forEach(function (sh) { cells += sh.getMaxRows() * sh.getMaxColumns(); });
  var stSh = sheet_(ss, SH.state, true), json = readJson_(stSh) || '';
  var all = errRows_(), seen = props.getProperty('ERR_SEEN') || '', d1 = new Date(Date.now() - 864e5).toISOString();
  var count = 0;
  try { count = backupList_().length; } catch (e) { count = 0; }
  return {
    now: new Date().toISOString(), version: ver_(stSh), app: VERSION, stateChars: json.length,
    cells: cells, cellsLimit: CELLS_LIMIT,
    backup: hGet_('backup'), backupCount: count, report: hGet_('report'), mirror: hGet_('mirror'), monthly: hGet_('monthly'),
    missing: missingTriggers_(),
    errors: {
      total: all.length,
      d1: all.filter(function (e) { return e.ts >= d1; }).length,
      unseen: all.filter(function (e) { return !seen || e.ts > seen; }).length,
      seenAt: seen
    },
    recent: all.slice(0, 50)
  };
}

function track_(key, fn) {
  try {
    var r = fn();
    hSet_(key, { at: new Date().toISOString(), ok: true, msg: clip_(r, 200) });
    return r;
  } catch (e) {
    var m = String((e && e.message) || e);
    hSet_(key, { at: new Date().toISOString(), ok: false, msg: clip_(m, 200) });
    errAdd_('الخادم: ' + key, m, (e && e.stack) || '');
    throw e;
  }
}

function hSet_(key, o) {
  try { PropertiesService.getScriptProperties().setProperty('H_' + key, JSON.stringify(o)); } catch (e) {}
}

function hGet_(key) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('H_' + key) || 'null'); } catch (e) { return null; }
}

function missingTriggers_() {
  var have = {};
  try { ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; }); } catch (e) { return []; }
  return [['mirror', 'تحديث الجداول'], ['backup', 'النسخ الاحتياطي'], ['dailyReport', 'التقرير اليومي'], ['monthlyReport', 'التقرير الشهري']]
    .filter(function (x) { return !have[x[0]]; }).map(function (x) { return x[1]; });
}

function healthWarnings_() {
  var w = [], now = Date.now(), b = hGet_('backup');
  if (!b) w.push('لم تُحفظ نسخة احتياطية بعد / No backup yet');
  else if (!b.ok) w.push('فشلت آخر نسخة احتياطية / Last backup failed');
  else if (now - new Date(b.at).getTime() > 26 * 3600e3) w.push('لا نسخة احتياطية منذ أكثر من يوم / No backup for over a day');
  var miss = missingTriggers_();
  if (miss.length) w.push('مهام تلقائية متوقفة / Stopped jobs: ' + miss.join('، '));
  try {
    var cells = 0;
    ss_().getSheets().forEach(function (sh) { cells += sh.getMaxRows() * sh.getMaxColumns(); });
    if (cells > CELLS_LIMIT * 0.7) w.push('الخلايا ' + Math.round(cells / CELLS_LIMIT * 100) + '% من حد Google / cells used');
  } catch (e) {}
  return w;
}

function errToday_(T) {
  return errRows_().filter(function (e) {
    try { return Utilities.formatDate(new Date(e.ts), 'Asia/Dubai', 'yyyy-MM-dd') === T; } catch (x) { return false; }
  }).length;
}

/** يضيف عطلًا من الخادم؛ لا يوقف العملية الأصلية أبدًا. */
function errAdd_(src, msg, det) {
  try {
    errSheet_(ss_()).appendRow([new Date().toISOString(), CUR_ ? CUR_.u : 'الخادم', '', '', '', clip_(src, 120), clip_(msg, 500), clip_(det, 1500), '', 'Apps Script']);
  } catch (e) {}
}

function errSheet_(ss) {
  var sh = sheet_(ss, SH.err, false);
  if (sh.getLastRow() === 0) {
    sh.appendRow(ERR_HEAD);
    try { sh.setFrozenRows(1); sh.setRightToLeft(true); sh.getRange('A:A').setNumberFormat('@'); } catch (e) {}
  }
  return sh;
}

/** الأحدث أولًا. */
function errRows_() {
  var sh = errSheet_(ss_()), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 10).getValues().reverse().map(function (r) {
    return { ts: String(r[0]), g: String(r[1]), u: String(r[2]), n: String(r[3]), r: String(r[4]), src: String(r[5]), m: String(r[6]), d: String(r[7]), v: String(r[8]) };
  });
}

/* ───────────── طلبات العملاء (صفحة الطلب العامة + نموذج Google) ───────────── */

var WEB_HEAD = ['المعرّف', 'وقت الطلب', 'الاسم', 'الهاتف', 'نوع العميل', 'الإمارة', 'المنطقة', 'العنوان', 'رابط الموقع',
  'العبوات المطلوبة (تعبئة)', 'الفوارغ المستبدلة', 'وقت التوصيل', 'طريقة الدفع', 'ملاحظات', 'الحالة', 'رقم الطلب في النظام', 'بواسطة', 'وقت المعالجة',
  'الأصناف', 'الإجمالي التقديري (د.إ)', 'الإحداثيات', 'المصدر'];
var WEB_KEYS = ['id', 'ts', 'n', 'ph', 't', 'em', 'a', 'ad', 'loc', 'q', 'r', 'tm', 'pm', 'nt'];
var WEB_EXTRA = ['it', 'tot', 'll', 'src'];   // الأعمدة 19–22
var WEB_NEW = 'جديد';

function webSheet_() {
  var sh = sheet_(ss_(), SH.web, false);
  if (sh.getLastRow() === 0) {
    sh.appendRow(WEB_HEAD);
    sh.setFrozenRows(1);
    sh.setRightToLeft(true);
  } else if (String(sh.getRange(1, 19).getValue()) !== WEB_HEAD[18]) {
    sh.getRange(1, 1, 1, WEB_HEAD.length).setValues([WEB_HEAD]);
  }
  return sh;
}

/** يُستدعى من صفحة الطلب ومن onOrderForm (Form.gs) عند كل طلب جديد. */
function webAdd_(o) {
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = webSheet_(), now = new Date(), r = sh.getLastRow() + 1;
    var id = 'W' + Utilities.formatDate(now, 'Asia/Dubai', 'yyMMdd') + '-' + r;
    if (!o.it) o.it = Number(o.q) > 0 ? [{ pid: 1, q: Math.floor(Number(o.q)) }] : [];
    var row = WEB_KEYS.map(function (k) {
      if (k === 'id') return id;
      if (k === 'ts') return Utilities.formatDate(now, 'Asia/Dubai', 'yyyy-MM-dd HH:mm');
      return clip_(o[k], 500);
    }).concat([WEB_NEW, '', '', '']).concat([
      JSON.stringify(o.it || []).substring(0, 4000), o.tot != null ? String(o.tot) : '',
      o.lat ? String(o.lat) + ',' + String(o.lng) : '', clip_(o.src || 'نموذج Google', 40)
    ]);
    sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    cache_().remove('WEB');
    return id;
  } finally {
    lock.releaseLock();
  }
}

function webPending_() {
  try { return webList_().length; } catch (e) { return 0; }
}

function webIds_() {
  return webList_().map(function (w) { return w.id; });
}

function webList(tok) {
  auth_(tok, 'web|ord.new|approve');
  return webList_();
}

function webList_() {
  var sh = webSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, WEB_HEAD.length).getValues()
    .filter(function (r) { return String(r[14]) === WEB_NEW && !webCl_(String(r[0])); })
    .map(function (r) {
      var o = {};
      WEB_KEYS.forEach(function (k, i) { o[k] = String(r[i]).replace(/^'/, ''); });
      WEB_EXTRA.forEach(function (k, i) { o[k] = String(r[18 + i] || ''); });
      try { o.it = JSON.parse(o.it || '[]'); } catch (e) { o.it = []; }
      if (!o.it.length && Number(o.q) > 0) o.it = [{ pid: 1, q: Math.floor(Number(o.q)) }];
      return o;
    });
}

/** حجز الطلب الوارد قبل قبوله أو رفضه، يمنع أن يقبله مستخدمان في نفس الوقت. */
var WEB_CLAIM_TTL = 600;   // يعود الطلب للظهور بعد 10 دقائق إن لم يُستكمل
function webCl_(id) {
  try { var x = cache_().get('WC:' + id); return x ? JSON.parse(x) : null; } catch (e) { return null; }
}

function webClaim(tok, id) {
  var s = auth_(tok, 'web|ord.new|approve');
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = webSheet_(), n = sh.getLastRow();
    if (n < 2) return { ok: false, gone: 1 };
    var R = sh.getRange(2, 1, n - 1, 18).getValues();
    for (var i = 0; i < R.length; i++) {
      if (String(R[i][0]) !== String(id)) continue;
      var stt = String(R[i][14]);
      if (stt !== WEB_NEW) return { ok: false, st: stt, oid: String(R[i][15] || ''), by: String(R[i][16] || '') };
      var cl = webCl_(id);
      if (cl && cl.u !== s.u) return { ok: false, st: 'قيد المعالجة', by: cl.n };
      cache_().put('WC:' + id, JSON.stringify({ u: s.u, n: s.name + ' (' + s.u + ')' }), WEB_CLAIM_TTL);
      cache_().remove('WEB');
      return { ok: true };
    }
    return { ok: false, gone: 1 };
  } finally {
    lock.releaseLock();
  }
}

/** ok=1: قُبل وأُدخل كطلب في النظام، ok=0: مرفوض (مع سبب اختياري). لا يُعاد معالجة طلب سبق قبوله أو رفضه. */
function webDone(tok, id, ok, oid, why) {
  var s = auth_(tok, 'web|ord.new|approve');
  var lock = LockService.getScriptLock();
  lock_(lock);
  try {
    var sh = webSheet_(), n = sh.getLastRow();
    if (n < 2) return false;
    var ids = sh.getRange(2, 1, n - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) !== String(id)) continue;
      if (String(sh.getRange(i + 2, 15).getValue()) !== WEB_NEW) { cache_().remove('WC:' + id); cache_().remove('WEB'); return false; }
      var stt = ok ? 'قُبل وأُدخل' : 'مرفوض' + (why ? ': ' + clip_(why, 200) : '');
      sh.getRange(i + 2, 15, 1, 4).setNumberFormat('@').setValues([[stt, oid ? String(oid) : '', clip_(s.name + ' (' + s.u + ')', 120),
        Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM-dd HH:mm')]]);
      cache_().remove('WEB');
      cache_().remove('WC:' + id);
      return true;
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

/** قائمة الأصناف والأسعار لصفحة الطلب العامة (بدون أي بيانات عملاء). */
function pubCatalog() {
  var c = cache_(), x = c.get('CAT');
  if (x) return JSON.parse(x);
  var st = JSON.parse(readJson_(sheet_(ss_(), SH.state, true)) || 'null') || {};
  var co = st.co || {}, P = [{ id: 1, n: 'مياه شرب 18.9 لتر', ne: 'Drinking water 18.9 L', u: 'عبوة', p: Number(st.pr189) || 0, b: 1 }];
  (st.pr || []).forEach(function (p) {
    if (Number(p.price) > 0 && p.web !== false) P.push({ id: p.id, n: p.name, ne: p.ne || '', u: p.unit || '', p: Number(p.price) });
  });
  var out = { p: P, dep: Number(st.depU) || 0, co: { n: co.n || 'ماي زين لتوزيع المياه المعدنية', ne: co.ne || 'MAI ZAIN MINERAL WATER DISTRIBUTION L.L.C', p: co.p || '+971 56 361 5251' } };
  c.put('CAT', JSON.stringify(out), 300);
  return out;
}

/** استقبال طلب من صفحة الطلب العامة أو من doPost. الأسعار تُحسب على الخادم ولا تُقبل من المتصفح. */
function pubOrder(o) {
  o = o || {};
  var c = cache_(), ph = String(o.ph || '').replace(/[^\d+]/g, ''), dg = ph.replace(/\D/g, '');
  var str = function (v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().substring(0, n); };
  if (str(o.hp, 50)) return { ok: true, ref: '' };                                   // حقل فخّ للبرامج الآلية
  if (str(o.n, 80).length < 2) throw new Error('أدخل الاسم / Enter your name');
  if (dg.length < 9 || dg.length > 15) throw new Error('أدخل رقم هاتف صحيحًا / Enter a valid phone number');
  if (EMS_.indexOf(str(o.em, 30)) < 0) throw new Error('اختر الإمارة / Choose the emirate');
  if (!str(o.a, 60)) throw new Error('أدخل المنطقة / Enter the area');
  if (!str(o.ad, 200)) throw new Error('أدخل العنوان / Enter the address');
  var dk = dg.slice(-9), g = Number(c.get('POG') || 0), pp = Number(c.get('PO:' + dk) || 0);
  if (g >= 60 || pp >= 3) throw new Error('تم استلام طلبات كثيرة من هذا الرقم. حاول بعد قليل أو تواصل عبر واتساب / Too many orders, try again later');
  var cat = pubCatalog(), byId = {};
  cat.p.forEach(function (p) { byId[p.id] = p; });
  var it = [], tot = 0;
  (Array.isArray(o.it) ? o.it : []).slice(0, 20).forEach(function (x) {
    var p = byId[Number(x.pid)], q = Math.floor(Number(x.q));
    if (!p || !(q > 0) || q > 500) return;
    it.push({ pid: p.id, q: q, pr: p.p, n: p.n });
    tot += q * p.p;
  });
  if (!it.length) throw new Error('اختر صنفًا واحدًا على الأقل / Choose at least one item');
  var r = Math.max(0, Math.min(500, Math.floor(Number(o.r) || 0)));
  var lat = Number(o.lat), lng = Number(o.lng), ll = inUAE_(lat, lng);
  var w = {
    n: str(o.n, 80), ph: ph, t: str(o.t, 40), em: str(o.em, 30), a: str(o.a, 60), ad: str(o.ad, 200),
    loc: /^https?:\/\//.test(str(o.loc, 300)) ? str(o.loc, 300) : (ll ? 'https://www.google.com/maps?q=' + lat + ',' + lng : ''),
    q: String(it.filter(function (x) { return x.pid === 1; }).reduce(function (a, x) { return a + x.q; }, 0)), r: String(r),
    tm: str(o.tm, 40), pm: str(o.pm, 40), nt: str(o.nt, 300), it: it, tot: Math.round(tot * 100) / 100,
    lat: ll ? lat : '', lng: ll ? lng : '', src: 'صفحة الطلب'
  };
  var id = webAdd_(w);
  c.put('POG', String(g + 1), 600);
  c.put('PO:' + dk, String(pp + 1), 600);
  try {
    var to = reportRecipients_();
    if (to.length) {
      MailApp.sendEmail({
        to: to.join(','), subject: 'طلب جديد من صفحة الطلب — ' + w.n + ' — ' + w.tot.toFixed(2) + ' د.إ',
        htmlBody: '<div dir="rtl" style="font-family:Arial,sans-serif"><h3 style="color:#0057b8">طلب جديد ' + id + '</h3><p>' + esc_(w.n) + ' — ' + esc_(w.ph) + '<br>' +
          esc_(w.em + ' — ' + w.a + ' — ' + w.ad) + '</p><p>' + it.map(function (x) { return esc_(x.n) + ' × ' + x.q; }).join('<br>') +
          '<br>فوارغ مستبدلة: ' + r + '</p><p><b>الإجمالي التقديري: ' + w.tot.toFixed(2) + ' د.إ</b></p><p>افتح النظام ← الطلبات لقبول الطلب أو رفضه.</p></div>'
      });
    }
  } catch (e) { /* الإشعار لا يوقف الطلب */ }
  return { ok: true, ref: id, total: w.tot };
}

function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/* ───────────── أدوات داخلية ───────────── */

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  if (!id) throw new Error('النظام غير مُعدّ. شغّل setup أولًا.');
  return SpreadsheetApp.openById(id);
}

function sheet_(ss, name, hidden) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (hidden) sh.hideSheet();
  }
  return sh;
}

function ver_(sh) {
  var v = sh.getRange(1, 1).getValue();
  return Number(v) || 0;
}

function readJson_(sh) {
  var n = sh.getLastRow();
  if (n < 2) return null;
  var vals = sh.getRange(2, 1, n - 1, 1).getValues();
  var s = vals.map(function (r) { return String(r[0]); }).join('');
  return s || null;
}

function writeJson_(sh, json, v) {
  var parts = [];
  for (var i = 0; i < json.length; i += CHUNK) parts.push([json.substring(i, i + CHUNK)]);
  var old = sh.getLastRow();
  sh.getRange(2, 1, parts.length, 1).setNumberFormat('@').setValues(parts);
  if (old > parts.length + 1) sh.getRange(parts.length + 2, 1, old - parts.length - 1, 1).clearContent();
  sh.getRange(1, 1).setValue(v);
  SpreadsheetApp.flush();
  try { cache_().put('V', String(v), 600); cache_().remove('CAT'); } catch (e) {}
}

function kvRows_(sh) {
  sh = sh || sheet_(ss_(), SH.kv, true);
  var n = sh.getLastRow();
  if (n < 1) return [];
  return sh.getRange(1, 1, n, 4).getValues();
}

function auditList_(limit) {
  var sh = sheet_(ss_(), SH.audit, false);
  var n = sh.getLastRow();
  if (n < 2) return [];
  var start = Math.max(2, n - limit + 1);
  return sh.getRange(start, 1, n - start + 1, 5).getValues().reverse().map(function (r, i) {
    return { id: String(n - i), json: JSON.stringify({ ts: String(r[0]), u: String(r[1]), n: String(r[2]), r: String(r[3]), m: String(r[4]) }) };
  });
}

function serverLog_(what, v, size) {
  try {
    sheet_(ss_(), SH.server, false).appendRow([new Date(), CUR_ ? CUR_.u + ' — ' + CUR_.name : (email_() || 'الخادم'), what, v, size]);
  } catch (e) { /* السجل لا يوقف الحفظ */ }
}

function email_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function checkCol_(col) {
  if (KV_COLS.indexOf(col) < 0) throw new Error('مجموعة غير معروفة: ' + col);
}

function checkId_(id) {
  if (!/^[A-Za-z0-9._@-]{1,80}$/.test(String(id))) throw new Error('معرّف غير صالح');
}

/** يقصّ النص ويمنع تفسيره كمعادلة داخل الجدول. */
function clip_(v, n) {
  v = v === undefined || v === null ? '' : String(v);
  n = n || 200;
  if (v.length > n) v = v.substring(0, n);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}
