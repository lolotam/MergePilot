/** The Jev judge settings card and its key types (ADR-0015). */
export const arJudge = {
  providerTypesafe: 'TypeSafe (لـ Jev فقط)',
  judgeCardTitle: 'الحَكَم (Jev)',
  judgeCardDesc:
    'نموذج قرار رخيص يراجع كل ملاحظة قبل نشرها (يستبعد الملاحظات الخاطئة) ويكتشف التعليقات المكررة لتعليق موجود. يُحاسب على توكنات المدخلات فقط.',
  judgeEnabled: 'تفعيل حَكَم Jev',
  judgeProviderLabel: 'مزود الحَكَم',
  judgeModelLabel: 'نموذج Jev',
  judgeModeLabel: 'الوضع',
  judgeModeOff: 'متوقف (فحص التكرار فقط)',
  judgeModeAnnotate: 'إضافة الثقة لكل تعليق',
  judgeModeFilter: 'فلترة (استبعاد الملاحظات تحت الحد)',
  judgeThresholdLabel: 'الحد',
  judgeThresholdHint: 'في وضع الفلترة تُستبعد الملاحظات الأقل من هذه الثقة، وتُذكر في ملخص المراجعة.',
  judgeNoKey: 'أضف مفتاحًا لهذا المزود في الأسفل أولًا.',
  judgeFallbackTitle: 'حكام احتياطيون',
  judgeFallbackDesc:
    'يُجرَّبون بالترتيب فقط لو فشل الحَكَم اللي قبلهم (مفتاح، حد طلبات، خادم، مهلة، نموذج غلط). ويُذكر ذلك دائمًا في الملخص.',
  judgeFallbackItem: 'احتياطي {index}',
  judgeAddFallback: 'إضافة احتياطي',
  judgeRemoveFallback: 'حذف الاحتياطي',
  judgeTestButton: 'اختبار',
  judgeTestOk: 'تمام · {model} · {ms}ms',
  judgeSave: 'حفظ إعدادات الحَكَم',
  judgeSaved: 'تم حفظ إعدادات الحَكَم',
};
