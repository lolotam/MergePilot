export const arSettings = {
  // New Providers (J2)
  providerOpenrouter: 'OpenRouter',
  providerDeepseek: 'DeepSeek',
  providerXai: 'xAI (Grok)',
  providerNvidia: 'NVIDIA',
  providerOpencodeZen: 'OpenCode Zen',
  providerOpencodeGo: 'OpenCode Go',
  providerZai: 'Z.ai',
  providerZaiCoding: 'Z.ai GLM Coding',
  providerCustom: 'مخصص (OpenAI-Compatible)',

  // Model selection
  searchModelsPlaceholder: 'ابحث عن نموذج...',
  refreshModelsButton: 'تحديث القائمة',
  loadingModels: 'جاري تحميل النماذج...',
  loadModelsError: 'تعذر تحميل قائمة النماذج',
  manualModelFallback: 'إدخال يدوي',
  manualModelFallbackHint: 'يمكنك كتابة اسم النموذج يدويًا في حال تعذر جلبه تلقائيًا',
  noModelsFound: 'لا توجد نماذج مطابقة',

  // Effort options
  effortNone: 'تلقائي / بدون تحديد',
  effortLow: 'منخفض (Low)',
  effortMedium: 'متوسط (Medium)',
  effortHigh: 'مرتفع (High)',

  // Heavy-duty model card
  heavyModelCardTitle: 'نموذج المهام الثقيلة',
  heavyModelCardDesc: 'نموذج أقوى يُستخدم تلقائيًا عندما يتجاوز حجم التغييرات في طلب السحب حدًا معينًا.',
  heavyModelEnabled: 'تفعيل نموذج المهام الثقيلة',
  heavyProviderLabel: 'مزود المهام الثقيلة',
  heavyModelLabel: 'نموذج المهام الثقيلة',
  heavyEffortLabel: 'جهد التفكير للمهام الثقيلة',
  heavyThresholdLabel: 'الحد الأدنى لعدد الأسطر المعدلة (Changed Lines)',
  heavyThresholdHint: 'الافتراضي 800 سطر (مجموع الأسطر المضافة والمحذوفة)',

  // Fallback models card
  fallbackCardTitle: 'النماذج الاحتياطية',
  fallbackCardDesc: 'يُستخدم النموذج الاحتياطي فقط عند فشل النموذج الرئيسي بسبب نفاد الحصة (Quota)، أو تجاوز معدل الطلبات (Rate limit)، أو أخطاء الخادم والشبكة، ويتم دائمًا الإفصاح عنه في ملخص المراجعة.',
  addFallbackButton: 'إضافة نموذج احتياطي',
  maxFallbacksReached: 'الحد الأقصى ٣ نماذج احتياطية',
  fallbackItemPriority: 'النموذج الاحتياطي {index}',
  moveUp: 'تحريك للأعلى',
  moveDown: 'تحريك للأسفل',
  removeFallback: 'إزالة',
  noFallbacksConfigured: 'لم يتم تحديد نماذج احتياطية (اختياري).',

  // Minimum severity
  minSeverityLabel: 'أقل خطورة تظهر في المراجعة',
  minSeverityHint: 'الملاحظات ذات الخطورة الأقل من هذا المستوى سيتم استبعادها تلقائيًا من المراجعة.',
  severityLow: 'منخفضة (Low)',
  severityMedium: 'متوسطة (Medium)',
  severityHigh: 'عالية (High)',
  severityCritical: 'حرجة (Critical)',

  // Key testing & Base URL
  testKeyAction: 'اختبار الاتصال',
  testingKey: 'جاري الاختبار...',
  testKeySuccess: 'الاتصال ناجح ({ms} مللي ثانية)',
  testKeyFailed: 'فشل الاتصال: {reason}',
  testBeforeSave: 'اختبر قبل الحفظ',
  baseUrlLabel: 'الرابط الأساسي (Base URL)',
  baseUrlPlaceholder: 'https://api.example.com/v1',
  baseUrlHelp: 'مطلوب للمزود المخصص، ويجب أن يكون رابط HTTPS آمن.',
  keyColBaseUrl: 'الرابط الأساسي',
};
