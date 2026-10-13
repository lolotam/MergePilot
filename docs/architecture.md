# MergePilot — المعمارية الحالية

> بتوصف شكل الكود المنفّذ. الحالة الحالية في [PRD v0.3](prd/v0.3.ar.md)، والقرارات في [`adr/`](adr/). تعديل الاشتراكات الحالي في [ADR-0020](adr/0020-dashboard-subscription-auth.md).

## 1. المبدأ

**محرك واحد، وكذا غلاف.**

- **المحرك** فيه منطق المراجعة كله.
- **الأغلفة** رفيعة وظيفتها بس:
  1. تجيب الحدث.
  2. تجيب المفاتيح.
  3. تنادي المحرك.
  4. تنشر النتيجة.

المحرك عمره ما بيعرف هو شغال جوه Action ولا جوه App ([ADR-0001](adr/0001-engine-library-with-action-shell.md)).

## 2. شكل المستودع (pnpm monorepo، TypeScript)

```
packages/
  engine/              المحرك — ما بيستوردش من apps/ أبدًا
    src/
      llm/             عقد LlmAdapter + LlmFailure + retry policy (مشتق من Harness، ADR-0003)
      providers/       anthropic/ openai/ gemini/ compatible/ — adapters لمزوّدي الـ API
                       subscription/ — تسجيل دخول وبروتوكولات اشتراكات Codex وClaude وGrok عن طريق pi-ai
                       claude-code/ — تشغيل Claude Code الأصلي للـ Action
      credentials/     CredentialStore + CredentialInfo (ADR-0002)
                       subscription.ts — envelope مشفّر لبيانات الاشتراك، منفصل عن مفتاح الـ API
      config/          قراءة .mergepilot.yml والتحقق منه (Zod)
      diff/            تحليل وتصنيف الفروقات والأسطر
      context/         نسخ المكتبات والتوثيق
      security/        كشف الأسرار وتعتيمها والمسارات الحساسة
      review/          بناء الـ prompt، استدعاء المزود، الـ schema بتاع الملاحظات
      validate/        مرور التحقق، التأكد من الموضع في الـ diff، منع التكرار، الترتيب
      budget/          تقدير التوكنات، جدول الأسعار، حدود الصرف
      audit/           الفحص الكامل الدوري — تقسيم المستودع وتجميع التقرير
      judge/           حَكَم Jev (System One): فلترة الملاحظات الغلط وفحص التكرار، بسلسلة احتياطي صريحة (ADR-0015)
      pricing/         جلب أسعار النماذج من القوايم العامة (OpenRouter وVercel وmodels.dev) وتحويلها (ADR-0016)
  github/              عميل GitHub: قراءة الـ PR بالصفحات، النشر، العلامة المخفية، فحص الـ SHA
apps/
  action/              GitHub Action (الإصدار الأول)
  app/                 GitHub App + API + خزنة المفاتيح + workers للمراجعة
  web/                 لوحة التحكم — إعدادات المزوّدين وتسجيل الدخول بالاشتراك
docs/  prd/  adr/  architecture.md  decisions.ar.md
reference/             مستودعات مرجعية — مستبعدة من git، قراءة بس
```

[ADR-0005](adr/0005-typescript-pnpm-monorepo.md) بيشرح ليه `engine` حزمة واحدة فيها فولدرات، بدل حزم كتير من الأول.

## 3. اتجاه الاعتماديات

```
apps/*  ──►  packages/github  ──►  packages/engine
apps/*  ──────────────────────────►  packages/engine
```

- `engine/src/llm` ما بيعتمدش على أي حاجة جوه المحرك.
- `providers/*` بتطبّق عقد `llm` وبتستخدم `credentials` و`security`، ومعاها SDKs أو pi-ai حسب الطريقة.
- `review` بياخد `ReviewModel`، من غير اعتماد على مزوّد معين. الـ factory بيبني النموذج من الإعدادات ومخزن بيانات الدخول.
- صياغة ونشر المراجعات موجودين في `packages/github`.
- `apps/app/src/api/contract*.ts` هو العقد المشترك بين Fastify ولوحة React. الـ worker بيحل بيانات الدخول من `CredentialService` قبل نداءات المحرك.

## 4. العقود الأساسية

```ts
// packages/engine/src/llm/adapter.ts
abstract class LlmAdapter {
  abstract readonly provider: string;
  abstract stream(opts: GenerateOptions): AsyncIterable<StreamChunk>;
  listModels?(): Promise<ModelEntry[]>;
  retryPolicy?: RetryPolicy;
}
// packages/engine/src/review/model.ts
interface ReviewModel {
  readonly label: string;
  readonly includedInSubscription?: boolean;
  generate(request: ReviewModelRequest): Promise<ReviewModelResponse>;
}

// credentials
interface CredentialStore {
  info(ref: CredentialRef): Promise<CredentialInfo>;       // من غير القيمة أبدًا
  resolve(ref: CredentialRef, purpose: RequestPurpose): Promise<Secret>;
}
```

## 5. قواعد ثابتة

- **مفيش تنفيذ لكود المستودع اللي بنراجعه، ولا تثبيت لاعتمادياته.**
- **أي سر اتحمّل مابيتكتبش في log، ولا بيرجع في خطأ، ولا بيروح للنموذج.**
- **مفيش تحويل خفي لمزود أو نموذج تاني.** أي فشل بيرجع `LlmFailure` واضح.
- **الكود اللي بننسخه من مراجع بترخيص MIT** ملفه بيحتفظ بإشعار الحقوق الأصلي، وبيتسجل في [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- **تسجيل الدخول بالاشتراك** بيستخدم مكتبة pi-ai، وتوكناته بتتخزن في الخزنة المشفّرة. استبدال بيانات الدخول وحذفها وتجديدها بيتزامنوا بقفل لكل مساحة عمل ومزوّد؛ التفاصيل في [تسجيل الدخول بالاشتراك](subscription-auth.md).
