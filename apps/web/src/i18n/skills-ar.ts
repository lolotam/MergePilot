/** مهارات المراجعة لكل بوت (ADR-0034): صفحة المهارات، والقائمة في تبويب كل بوت، وملاحظة المهارة المحذوفة. */
export const arSkills = {
  skillsCardTitle: 'مهارات المراجعة',
  skillsCardDesc:
    'المهارة ملف Markdown فيه تعليمات زيادة لبوت معين. بتتضاف فوق تعليمات المراجعة الأساسية ومش بتلغيها. كل بوت يختار مهارة واحدة من تبويبه.',
  skillsLoadFailed: 'مقدرناش نحمّل المهارات.',
  skillsEmpty: 'لسه مفيش مهارات في مساحة العمل دي.',
  skillsColName: 'الاسم',
  skillsColSize: 'الحجم',
  skillsColUpdated: 'آخر تعديل',
  skillsColUsedBy: 'البوتات اللي بتستخدمها',
  skillsSize: '{size} / {max} توكن',
  skillsUnused: 'مش مستخدمة',
  skillsBotSlot: 'بوت {slot}',
  skillsLimitReached: 'وصلت للحد الأقصى ({max} مهارة). احذف مهارة الأول عشان تضيف واحدة جديدة.',

  // Upload
  skillsUploadTitle: 'رفع مهارة',
  skillsNameLabel: 'اسم المهارة',
  skillsFileLabel: 'ملف Markdown ‏(.md أو .markdown)',
  skillsUploadButton: 'رفع المهارة',
  skillsUploading: 'بنرفع...',
  skillsUploaded: 'تم رفع المهارة',
  skillsNameRequired: 'اكتب اسم للمهارة',
  skillsNameTooLong: 'الاسم لازم ميزيدش عن {max} حرف',
  skillsFileRequired: 'اختار ملف Markdown',
  skillsFileWrongType: 'مسموح بس بملفات .md و .markdown',
  skillsFileTooLarge: 'الملف ده تقريبًا {size} توكن، والحد الأقصى {max} توكن.',
  skillsFileUnreadable: 'مقدرناش نقرا الملف.',

  // Templates
  skillsTemplatesTitle: 'إضافة من قالب',
  skillsTemplatesDesc: 'كل قالب بيعمل مهارة عادية في مساحة العمل، تقدر تعدّلها براحتك.',
  skillsTemplateOwnerRules: 'قواعد صاحب المشروع',
  skillsTemplateContextOutsideDiff: 'السياق برّه التعديلات',
  skillsTemplateCrossFileConsumers: 'الملفات اللي بتستخدم التغيير',
  skillsTemplateSecurity: 'الأمان وسلامة البيانات',
  skillsTemplateAdded: 'المهارة «{name}» اتضافت من القالب',

  // Row actions
  skillsPreview: 'معاينة',
  skillsHidePreview: 'إخفاء المعاينة',
  skillsPreviewLoading: 'بنحمّل المحتوى...',
  skillsPreviewOf: 'محتوى المهارة «{name}»',
  skillsEdit: 'تعديل',
  skillsDelete: 'حذف',
  skillsActionsFor: 'إجراءات «{name}»',

  // Edit
  skillsEditTitle: 'تعديل «{name}»',
  skillsEditDesc: 'غيّر الاسم، أو اختار ملف جديد بدل المحتوى الحالي. لو مختارتش ملف المحتوى بيفضل زي ما هو.',
  skillsReplaceFileLabel: 'ملف جديد (اختياري)',
  skillsSave: 'حفظ',
  skillsSaved: 'تم حفظ المهارة',
  skillsNothingChanged: 'مفيش حاجة اتغيرت.',

  // Delete
  skillsDeleteTitle: 'حذف «{name}»؟',
  skillsDeleteUnused: 'مفيش بوت بيستخدم المهارة دي. الحذف مش بيترجع.',
  skillsDeleteUsed:
    'البوتات دي بتستخدم المهارة: {bots}. بعد الحذف هيراجعوا بالتعليمات الأساسية بس، وأول مراجعة جاية لكل طلب سحب مفتوح هتكون مراجعة كاملة.',
  skillsDeleted: 'تم حذف المهارة',

  // Errors
  skillErrorNameTaken: 'فيه مهارة تانية بنفس الاسم في مساحة العمل دي',
  skillErrorLimit: 'وصلت للحد الأقصى لعدد المهارات',
  skillErrorEmpty: 'الملف فاضي',
  skillErrorTooLarge: 'المهارة أكبر من الحد المسموح ({max} توكن)',
  skillErrorNotText: 'الملف ده مش نص عادي',
  skillErrorCredential: 'الاسم أو الملف فيه حاجة شكلها مفتاح أو كلمة سر. شيلها وجرّب تاني.',
  skillErrorUnknown: 'المهارة دي مش موجودة في مساحة العمل',

  // The per-bot dropdown
  skillSelectLabel: 'المهارة',
  skillSelectDefault: 'الافتراضي (التعليمات الأساسية بس)',
  skillSelectHint: 'تعليمات زيادة للبوت ده فوق التعليمات الأساسية. ضيف مهارات من كارت «مهارات المراجعة».',
  skillRemovedNote: 'المهارة «{name}» اتحذفت، والبوت ده بقى بيراجع بالتعليمات الأساسية بس.',

  // Runs
  runSkillLabel: 'المهارة',
};
