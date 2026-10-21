/**
 * MAI ZAIN — نموذج طلبات العملاء (Google Forms)
 * يُضاف ملفًا جديدًا باسم Form.gs داخل مشروع Apps Script نفسه، ثم تُشغَّل الدالة createOrderForm مرة واحدة.
 * ينشئ: نموذج طلب ثنائي اللغة + جدول ردود منفصل + إشعار بريد فوري لكل طلب فيه رابط واتساب للعميل.
 * 10.7: كل طلب يُرسل أيضًا إلى النظام (ورقة «طلبات النموذج») ويظهر في شاشة الطلبات للإدخال بضغطة.
 */

/** مفاتيح الحقول حسب بداية عنوان السؤال (لا تغيّر بداية العناوين في النموذج). */
var ORDER_FIELDS = [
  ['الاسم', 'n'], ['رقم الهاتف', 'ph'], ['نوع العميل', 't'], ['الإمارة', 'em'], ['المنطقة', 'a'],
  ['العنوان', 'ad'], ['رابط الموقع', 'loc'], ['عدد عبوات', 'q'], ['عدد العبوات الفارغة', 'r'],
  ['الوقت المفضل', 'tm'], ['طريقة الدفع', 'pm'], ['ملاحظات', 'nt']
];

var ORDER_FORM_TITLE = 'MAI ZAIN — طلب مياه | Water Order';
var ORDER_NOTIFY_SUBJECT = 'طلب جديد من النموذج — MAI ZAIN';

/** فحص سريع: هل خدمة Google Forms تعمل لهذا الحساب؟ شغّلها أولًا إن ظهر «خطأ غير معروف». */
function testFormsAccess() {
  Logger.log('الحساب: ' + Session.getEffectiveUser().getEmail());
  var f = FormApp.create('MAI ZAIN — اختبار (يمكن حذفه)');
  Logger.log('✅ Google Forms يعمل: ' + f.getEditUrl());
  DriveApp.getFileById(f.getId()).setTrashed(true);
  Logger.log('✅ تم حذف نموذج الاختبار. شغّل الآن createOrderForm');
}

function createOrderForm() {
  Logger.log('1/4 بدء الإنشاء — الحساب: ' + Session.getEffectiveUser().getEmail());
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ORDER_FORM_ID')) {
    var old = FormApp.openById(props.getProperty('ORDER_FORM_ID'));
    Logger.log('النموذج موجود بالفعل: ' + old.getPublishedUrl());
    return old.getPublishedUrl();
  }
  var form = FormApp.create(ORDER_FORM_TITLE);
  form.setDescription(
    'ماي زين لتوزيع المياه المعدنية — اطلب مياه الشرب وسنتواصل معك لتأكيد الطلب وموعد التوصيل.\n' +
    'MAI ZAIN Mineral Water Distribution — order your drinking water and we will contact you to confirm the delivery time.\n' +
    'واتساب / WhatsApp: +971 56 361 5251'
  );
  try { form.setRequireLogin(false); } catch (e) { /* حساب شخصي */ }
  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(false);
  form.setConfirmationMessage(
    'شكرًا لك! تم استلام طلبك وسنتواصل معك قريبًا لتأكيد موعد التوصيل.\n' +
    'Thank you! Your order has been received. We will contact you shortly to confirm the delivery time.\n' +
    'للطلبات العاجلة / Urgent: WhatsApp +971 56 361 5251'
  );

  form.addTextItem().setTitle('الاسم / Name').setRequired(true);

  var phoneRule = FormApp.createTextValidation()
    .setHelpText('أدخل رقمًا صحيحًا، مثال: 0501234567 / Enter a valid number, e.g. 0501234567')
    .requireTextMatchesPattern('^[+0-9 ]{9,15}$').build();
  form.addTextItem().setTitle('رقم الهاتف (واتساب) / Phone (WhatsApp)').setRequired(true).setValidation(phoneRule);

  form.addMultipleChoiceItem().setTitle('نوع العميل / Customer type')
    .setChoiceValues(['منزل / Home', 'مكتب أو شركة / Office', 'محل تجاري / Shop', 'مطعم أو مقهى / Restaurant or café'])
    .setRequired(true);

  form.addListItem().setTitle('الإمارة / Emirate')
    .setChoiceValues(['عجمان / Ajman', 'الشارقة / Sharjah', 'دبي / Dubai', 'أم القيوين / Umm Al Quwain',
      'رأس الخيمة / Ras Al Khaimah', 'أبوظبي / Abu Dhabi', 'الفجيرة / Fujairah'])
    .setRequired(true);

  form.addTextItem().setTitle('المنطقة / Area').setRequired(true);
  form.addParagraphTextItem().setTitle('العنوان التفصيلي (المبنى، الشقة، أقرب معلم) / Full address').setRequired(true);
  form.addTextItem().setTitle('رابط الموقع على خرائط Google (اختياري) / Google Maps link (optional)');

  var qtyRule = FormApp.createTextValidation()
    .setHelpText('من 1 إلى 500 / From 1 to 500')
    .requireNumberBetween(1, 500).build();
  form.addTextItem().setTitle('عدد عبوات 18.9 لتر المطلوبة / Number of 18.9 L bottles').setRequired(true).setValidation(qtyRule);

  var retRule = FormApp.createTextValidation().requireNumberBetween(0, 500).build();
  form.addTextItem().setTitle('عدد العبوات الفارغة للإرجاع (إن وجدت) / Empty bottles to return (if any)').setValidation(retRule);

  form.addMultipleChoiceItem().setTitle('الوقت المفضل للتوصيل / Preferred delivery time')
    .setChoiceValues(['صباحًا 8–12 / Morning 8–12', 'ظهرًا 12–4 / Afternoon 12–4', 'مساءً 4–8 / Evening 4–8'])
    .setRequired(true);

  form.addMultipleChoiceItem().setTitle('طريقة الدفع / Payment method')
    .setChoiceValues(['نقدًا عند التسليم / Cash on delivery', 'بطاقة عند التسليم / Card on delivery', 'تحويل بنكي / Bank transfer'])
    .setRequired(true);

  form.addParagraphTextItem().setTitle('ملاحظات / Notes');

  Logger.log('2/4 تمت إضافة الأسئلة');
  // جدول ردود منفصل عن قاعدة بيانات النظام
  var ss = SpreadsheetApp.create('MAI ZAIN — طلبات العملاء (النموذج)');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  Logger.log('3/4 تم ربط جدول الردود');
  // إشعار فوري عند كل طلب
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'onOrderForm') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onOrderForm').forForm(form).onFormSubmit().create();

  props.setProperty('ORDER_FORM_ID', form.getId());
  Logger.log('4/4 تم إنشاء الإشعار — اكتمل ✅');
  Logger.log('رابط النموذج للعملاء: ' + form.getPublishedUrl());
  Logger.log('رابط تعديل النموذج: ' + form.getEditUrl());
  Logger.log('جدول الردود: ' + ss.getUrl());
  return form.getPublishedUrl();
}

/** يُشغَّل تلقائيًا عند كل طلب: بريد للإدارة فيه تفاصيل الطلب ورابط واتساب للعميل. */
function onOrderForm(e) {
  var rows = [], o = {};
  e.response.getItemResponses().forEach(function (r) {
    var t = r.getItem().getTitle(), v = String(r.getResponse() || '');
    ORDER_FIELDS.forEach(function (f) { if (t.indexOf(f[0]) === 0) o[f[1]] = v; });
    rows.push('<tr><td style="padding:6px 10px;color:#4a6283;direction:rtl;text-align:right">' + esc_(t) +
      '</td><td style="padding:6px 10px;font-weight:bold;text-align:right">' + esc_(v) + '</td></tr>');
  });
  var phone = o.ph || '', name = o.n || '', inSys = '';
  try {
    if (typeof webAdd_ === 'function') { webAdd_(o); inSys = 'ok'; }
  } catch (err) {
    inSys = String(err && err.message || err);
    try { errAdd_('الخادم: نموذج الطلبات', inSys, name + ' ' + phone); } catch (x) { /* بدون سجل */ }
  }
  var d = phone.replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('0') === 0) d = '971' + d.slice(1); else if (d.length === 9 && d.charAt(0) === '5') d = '971' + d;
  var wa = d.length >= 11 ? 'https://wa.me/' + d + '?text=' + encodeURIComponent('مرحبًا ' + name + '، معك ماي زين لتوزيع المياه بخصوص طلبك. نؤكد لك موعد التوصيل:') : '';
  var html = '<div style="font-family:Arial,sans-serif;max-width:620px;direction:rtl">' +
    '<h2 style="color:#0057b8;margin:0 0 8px">طلب مياه جديد من النموذج</h2>' +
    '<div style="color:#4a6283;margin-bottom:10px">' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM-dd HH:mm') + '</div>' +
    '<table style="border-collapse:collapse;width:100%;background:#f3f8fc">' + rows.join('') + '</table>' +
    (wa ? '<p><a href="' + wa + '" style="display:inline-block;background:#25a244;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">مراسلة العميل على واتساب</a></p>' : '') +
    (inSys === 'ok'
      ? '<p style="color:#4a6283;font-size:12px">الطلب ظاهر الآن في النظام: الطلبات ← «طلبات واردة من نموذج العملاء» ← إدخال كطلب.</p>'
      : '<p style="color:#c62828;font-size:12px">تعذر إرسال الطلب إلى النظام تلقائيًا (' + esc_(inSys || 'Code.gs غير موجود') + '). أدخله يدويًا: الطلبات ← طلب جديد.</p>') + '</div>';
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: ORDER_NOTIFY_SUBJECT + ' — ' + name,
    htmlBody: html
  });
}

function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
