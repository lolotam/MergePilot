/** Google Antigravity subscription (ADR-0032). */
export const arAntigravity = {
  providerGoogleAntigravity: 'Google Antigravity',
  subscriptionGoogle: 'تسجيل الدخول بحساب Google (Antigravity)',
  antigravitySubscriptionOnly: 'Google Antigravity بيشتغل بتسجيل دخول الاشتراك بس، ومالوش مفاتيح API.',
  antigravityTermsNotice:
    'شروط Google بتمنع استخدام أي أداة طرف تالت للوصول لـ Antigravity. Google ممكن توقف وصول الحساب ده لـ Antigravity أو تقفله. استخدم حساب انت قابل الخطر ده عليه.',
  antigravityTermsAck: 'فاهم الخطر على حساب Google ده',
  antigravityPasteHelp:
    'بعد تسجيل الدخول المتصفح هيفتح صفحة مش هتفتح (localhost). انسخ العنوان كله من شريط العنوان والصقه تحت. لو فيه برنامج شغال على البورت 51121 على جهازك، هو اللي هيستلم الكود.',
  antigravityPasteLabel: 'العنوان من المتصفح',
  providerUnavailableNote: 'السيرفر ده مش بيقدّم تسجيل دخول {provider}، فالاختيار المحفوظ ده مش هيشتغل. اختار مزوّد تاني.',
  subscriptionErrorDenied: 'تسجيل الدخول بـ Google اتلغى أو اترفض.',
  subscriptionErrorStateMismatch: 'العنوان ده تبع تسجيل دخول تاني. ابدأ تسجيل دخول جديد والصق العنوان اللي بيفتحه.',
  subscriptionErrorInvalidPaste: 'الصق العنوان كله من المتصفح، اللي بيبدأ بـ http://localhost:51121/.',
  subscriptionErrorTokenExchange: 'Google ما قبلتش كود الدخول. ابدأ تسجيل دخول جديد.',
  subscriptionErrorValidationRequired: 'Google عايزة تتأكد من الحساب الأول. أكّده في المتصفح، وبعدها سجّل الدخول تاني.',
  subscriptionErrorIneligible: 'حساب Google ده مش مسموح له يستخدم Antigravity.',
  subscriptionErrorProjectRequired: 'الحساب ده محتاج Google Cloud project، وحسابات الشركات لسه مش مدعومة.',
};
