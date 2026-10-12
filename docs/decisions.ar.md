# سجل قرارات صاحب المشروع — MergePilot

كل سؤال مكتوب معاه الاختيارات، والتوصية، وإجابة صاحب المشروع **بنصّها**.

## الدفعة 1 — 2026-10-11

### س1: MergePilot معمول لمين في الأساس؟

**الاختيارات:**

- داخلي الأول ثم منتج (التوصية)
- أداة داخلية بس
- منتج للبيع من أول يوم

**الإجابة:** «داخلي الأول ثم منتج»

### س2: الإصدار الأول هيشتغل إزاي؟

**الاختيارات:**

- GitHub Action
- GitHub App على سيرفر
- الاتنين على مراحل

**الإجابة الأولى:** «لعبه انخفاض، اشرح لي الموضوع ده أكتر لأنني مش فاهم الخطوة دي بالظبط، وما الفرق بينهم في الصعوبة وفي الكود وفي كل شيء؟ وما هي الميزات وما هي العيوب؟»

اتشرح الفرق، واتسأل السؤال تاني.

**الإجابة بعد الشرح:** «محرك مستقل + Action الأول» ← [ADR-0001](adr/0001-engine-library-with-action-shell.md)

### س3: إيه أهم حاجة MergePilot لازم يعملها أحسن من الأدوات الموجودة؟

**الاختيارات (أكتر من اختيار مسموح):**

- يفهم قواعد المشروع
- تعليقات بالعربي
- اختيار المزود والتكلفة
- ملاحظات أقل وأدق

**الإجابة:** «every PR review and code base and security gabs and best app code strucure according every future liberary» + «يفهم قواعد المشروع» + «تعليقات بالعربي» + «اختيار المزود والتكلفة»

### س4: ترتيبه إيه في الأولويات؟

**الإجابة:** شغل خفيف جنب مشاريع تانية.

> **تصحيح 2026-10-11 (من صاحب المشروع):** MergePilot مشروع مستقل تمامًا ومالوش أي علاقة بأي مشروع تاني. الربط اللي كان هنا جه من افتراض غلط من المنفّذ، واتشال.

### س5: مراجعة «الكود كله» وثغرات الأمان تبقى إزاي؟

**الاختيارات:**

- PR + سياق المشروع + فحص كامل دوري (التوصية)
- PR + سياق بس
- الكود كله مع كل PR

**الإجابة:** «PR + سياق المشروع + فحص كامل دوري»

### س6: يعني إيه «أفضل بنية حسب كل مكتبة»؟

**الاختيارات:**

- يقارن بأحدث توثيق للنسخة المستخدمة (التوصية)
- قواعد مكتوبة إحنا اللي نحددها
- الاتنين

**الإجابة:** «يقارن بأحدث توثيق للنسخة المستخدمة»

### س7: عندك API key مدفوع لأنهي مزود؟

**الإجابة:** «api and auth way as i add loally 3 projects use agent provider auth way so try to check all the 3 project to choose which implemntaion auth way for multible agent models and providers» + Claude API + OpenAI API + Gemini API

اتحللت المستودعات التلاتة (PRD v0.2 §3.2). الخلاصة:

- مسارات تسجيل الدخول بالاشتراكات مرفوضة.
- التصميم الهندسي فيهم هيتاخد.

### س8: طبقة الاتصال بالمزودين نبنيها إزاي؟

**الاختيارات:**

- Vercel AI SDK (التوصية)
- adapters فوق الـ SDKs الرسمية
- طبقة الـ Harness نفسها

**الإجابة:** «use deep seek harness code base: نحلل طريقة الـ OAuth الموجودة في Plugins ونبني Multi-Provider Engine خاص بينا»

النتيجة:

- [ADR-0003](adr/0003-provider-layer-from-deepseek-harness.md)
- [ADR-0004](adr/0004-policy-gated-oauth-framework.md): اتحسمت في س11 وس12: OAuth بالاشتراكات **جوه محركنا** ممنوع، والاشتراكات بتشتغل عن طريق ADR-0006

### س9: مين هينفّذ؟

**الإجابة:** «نقرر بعدين» ← **PENDING**

### س11: قصدك إن MergePilot يشتغل باشتراكات الناس (ChatGPT / Claude)؟

**الإجابة:** «yes قصدك إن MergePilot يشتغل باشتراكات الناس»

بعدها مباشرة: «هنستخدم مكتبة pi-ai، لأنها جواها مسارات تسجيل الدخول بالاشتراكات» + «in the deepseek harness»

**رد المنفّذ (Claude):**

- مسارات pi-ai للاشتراكات بتستخدم أرقام تعريف أدوات تانية وبتنتحل شخصيتها.
- ده ممنوع صراحةً في صفحة Anthropic بتاريخ 2026-10-11. وAnthropic بتقول إنها ممكن تطبّق المنع «without prior notice».
- عشان كده Claude **مش هيبنيها**.

**البديل المقترح:** الطريق الرسمي للاشتراكات، وهو تشغيل Claude Code الأصلي بحساب المستخدم نفسه ← [ADR-0006](adr/0006-subscriptions-via-official-agent-clis.md). الحالة: اتحسمت في س12.

### س12: توافق على الطريق الرسمي للاشتراكات (ADR-0006)؟

**الإجابة:** «use نفس الصفحة بتسمح بحاجة مهمة: المنتج يشغّل Claude Code الأصلي من غير تعديل، وكل مستخدم يسجّل دخوله باشتراكه هو عن طريق Anthropic نفسها.»

← ADR-0006 بقى **Accepted** لمسار Claude Code. مسار Codex لسه مقفول لحد ما نلاقي إذن رسمي.

### س10: الخطوة الجاية؟

**الإجابة:** «أيوه، جهّز الريبو والوثيقة»

## الدفعة 2 — 2026-10-11

### س13: الـ GitHub App معمول لمين في النسخة الأولى؟

**الاختيارات:** ليا الأول وبعدين عملاء (التوصية) · عملاء من أول يوم (SaaS كامل)

**الإجابة:** «عملاء من أول يوم (SaaS كامل)»

### س14: السيرفر يشتغل فين؟

**الاختيارات:** سيرفر Dokploy (التوصية) · سيرفر جديد منفصل · Vercel / Cloud Run

**الإجابة:** «سيرفر Dokploy بتاعك» — والدومين: «http://mergepilot.walidmohamed.com»


## الدفعة 3 — 2026-10-12

### س15: بيانات صفحتي الخصوصية والشروط

**الإجابة:** «email:admin@walidmohamed.com» · «اسم المشغّل Walidmohamed» · «القانون المطبّق kuwait»

## الدفعة 4 — 2026-10-12

### س16: إضافة المزودين وقائمة النماذج ومنطق النماذج الاحتياطية (Fallback)

**الإجابة:** «Clone all model system and providers and fale back logic from this repo so add fall back models and add all these providers to the list»

## الدفعة 5 — 2026-10-12

### س17: قوائم النماذج والجهد التفكيري، اختبار المفاتيح، والنموذج الثقيل في صفحة الإعدادات

**طلبات صاحب المشروع (بنصّها):**
- «i want when addng the provider api key will show drop down list of all its models with its thinking effors so chang the model from manully enter to drop down list to show all the model under this provider»
- «in Provider API Keys in the tabel recoords for evcery model add test icon to test if sucesfull connected or failed»
- «yes add all these suggestion make the user slect the model for heavy duty» (الاقتراحات: effort high، نموذج أقوى للـ PRs الكبيرة، تحديد الحد الأدنى للخطورة)

