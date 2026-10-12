# MergePilot — المعمارية (A0.1)

> بتوصف **شكل الكود** المخطط. المتطلبات في [PRD v0.2](prd/v0.2.ar.md)، والقرارات في [`adr/`](adr/).
> لو حصل تعارض: الـ PRD بيكسب في **إيه** نبني، والملف ده بيكسب في **شكل** الكود.

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
      providers/       anthropic/ openai/ gemini/ — adapters فوق الـ SDKs الرسمية
                       agent-cli/claude-code/ — AgentCliRunner بيشغّل Claude Code الأصلي (ADR-0006)
      credentials/     CredentialStore + CredentialInfo (ADR-0002)
      auth/            إطار OAuth + TokenManager — مقفول افتراضيًا (ADR-0004)
      config/          قراءة .mergepilot.yml والتحقق منه (Zod)
      context/         diff، الملفات المرتبطة، ملفات القواعد، نسخ المكتبات، التوثيق
      analyzers/       فحص الأسرار + قواعد ثابتة آمنة (ما بتشغلش كود المستودع)
      review/          بناء الـ prompt، استدعاء المزود، الـ schema بتاع الملاحظات
      validate/        مرور التحقق، التأكد من الموضع في الـ diff، منع التكرار، الترتيب
      budget/          تقدير التوكنات، جدول الأسعار، حدود الصرف
      audit/           الفحص الكامل الدوري — تقسيم المستودع وتجميع التقرير
      judge/           حَكَم Jev (System One): فلترة الملاحظات الغلط وفحص التكرار، بسلسلة احتياطي صريحة (ADR-0015)
      publish/         صياغة المراجعة (ملخص + تعليقات) — بدون استدعاء GitHub نفسه
  github/              عميل GitHub: قراءة الـ PR بالصفحات، النشر، العلامة المخفية، فحص الـ SHA
apps/
  action/              GitHub Action (الإصدار الأول)
  cli/                 تشغيل محلي على PR موجود — dry-run افتراضيًا
  app/                 GitHub App + سيرفر (المرحلة التانية — مش موجود دلوقتي)
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
- `providers/*` بتعتمد بس على `llm` و`credentials`.
- `review` بيعتمد على `llm`، وعمره ما بيعتمد على مزود معين.
- `review` بيختار المزود عن طريق الـ registry.
- `publish` بيبني شكل المراجعة كبيانات. الإرسال نفسه بيحصل في `packages/github`.

## 4. العقود الأساسية (بالأسماء — التفاصيل وقت التنفيذ)

```ts
// llm — مشتق من DeepSeek Harness (MIT)
abstract class LlmAdapter {
  abstract stream(opts: GenerateOptions): AsyncIterable<StreamChunk>;
  listModels?(): Promise<ModelEntry[]>;
  retryPolicy?: RetryPolicy;
}
type StreamChunk = TextDelta | ToolCallDelta | Usage | Finish;
type LlmFailure = { code: LlmFailureCode; message: string; status?: number;
                    retryAfterMs?: number; requestId?: string };
// LlmFailureCode: INVALID_CREDENTIAL | RATE_LIMIT | QUOTA | CONTEXT_WINDOW_EXCEEDED
//                 | TIMEOUT | SERVER | BAD_REQUEST

// review
interface ReviewProvider {
  capabilities(): ProviderCapabilities;
  validateConnection(): Promise<ConnectionStatus>;
  estimateUsage(req: ReviewRequest): UsageEstimate;
  review(req: ReviewRequest): Promise<ReviewResult>;
}
type Finding = { id; path; line; side; title; body; severity; category;
                 evidence; suggestion?; ruleRef?; confidence };

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
- **مفيش أي كود من مسارات تسجيل الدخول بالاشتراكات** في `reference/`.
