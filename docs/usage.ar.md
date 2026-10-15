# دليل استخدام MergePilot

MergePilot بيراجع Pull Requests عن طريق GitHub Action أو GitHub App ولوحة تحكم، ويدعم Claude وOpenAI وGemini وGrok وباقي مزوّدي الـ API.

## تفعيل GitHub App ولوحة التحكم

1. سجّل الدخول بـ Google أو GitHub، وافتح مساحة العمل بتاعتك.
2. ركّب GitHub App واربط الريبوهات المطلوبة بمساحة العمل.
3. افتح **الإعدادات → بيانات الدخول للمزوّدين → إضافة بيانات دخول**.
4. اختار المزوّد وطريقة الدخول: **مفتاح API**، أو **اشتراك** لـ OpenAI/Anthropic/xAI.
5. لـ Gemini وOpenRouter وOpenCode Zen: زر **+** جنب حقل المفتاح يضيف مفتاح تاني (لحد 20). كل حقل ليه اختبار وإزالة قبل الحفظ. وقت المراجعة نفس المزوّد ونفس النموذج؛ لو الحصة خلصت (429 أو رسالة quota) بيتجرّب المفتاح اللي بعده، وبيتسجّل رقم المفتاح من غير ما يظهر السر.
6. للاشتراك: OpenAI/Codex وGrok بيعرضوا صفحة دخول وكود جهاز؛ Claude بيطلب تلصق كود التفويض بعد الدخول. [التفاصيل](subscription-auth.md).
7. اختار النموذج من القايمة المحدّثة، واحفظ إعدادات المراجعة، واضغط اختبار الاتصال.

كل مزوّد تاني ليه بيانات دخول نشطة واحدة في مساحة العمل؛ تغيير الطريقة بيستبدل القديمة. الأعضاء بيشوفوا المراجعات، والأدمن والمالك بيغيّروا بيانات الدخول. الخطوات التالية خاصة بتشغيل **GitHub Action**.

---

## 1. إيه اللي بيعمله MergePilot؟

- **ملخص عربي للـ PR:** بيكتب ملخص واضح ومفهوم للتغييرات اللي حصلت في الـ PR.
- **ملاحظات محددة على السطور:** بينشر تعليقات دقيقة ومتحقق منها جنب السطور البرمجية المتغيرة في الـ diff فقط.
- **فهم سياق وقواعد المشروع:** بيقرأ ملفات القواعد الخاصة بمستودعك (مثل `CLAUDE.md` و`AGENTS.md`) ويلتزم بيها.
- **فحص استخدام المكتبات:** بيتحقق من توافق الكود مع توثيق نسخ المكتبات المحددة في ملفات الاعتماديات.
- **أمان كامل:** مفيش أي تنفيذ لكود الـ PR أو تثبيت لاعتمادياته أثناء المراجعة.

---

## 2. خطوات التفعيل (4 خطوات سريعة)

### الخطوة 1: ضيف السر (Secret) في مستودعك

ادخل على مستودعك في GitHub:
`Settings` ← `Secrets and variables` ← `Actions` ← اضغط **New repository secret**.

ضيف المفتاح المناسب للمزود اللي اخترته:

| المزود | اسم الـ Secret المطلوب | منين تجيبه؟ |
|---|---|---|
| **Anthropic (Claude API)** | `ANTHROPIC_API_KEY` | من حسابك في [Anthropic Console](https://console.anthropic.com/) |
| **OpenAI (GPT)** | `OPENAI_API_KEY` | من حسابك في [OpenAI Platform](https://platform.openai.com/) |
| **Google Gemini** | `GEMINI_API_KEY` | من [Google AI Studio](https://aistudio.google.com/) |
| **Claude Code CLI (اشتراك Pro/Max)** | `CLAUDE_CODE_OAUTH_TOKEN` | من الأمر `claude setup-token` (انظر الشرح أدناه) |

> [!TIP]
> **كيفية استخراج توكن Claude Code (`claude setup-token`):**
> 1. على جهازك الشخصي، اتأكد إنك مثبت أداة Claude Code ومسجل دخولك باشتراكك (Claude Pro أو Max).
> 2. شغل الأمر التالي في الطرفية:
>    ```bash
>    claude setup-token
>    ```
> 3. انسخ التوكن اللي هيظهرلك، وضيفه كـ Secret في مستودعك باسم `CLAUDE_CODE_OAUTH_TOKEN`.
>    - التوكن الصح **بيبدأ بـ `sk-ant-oat01-`**. لو اللي معاك بيبدأ بـ `sk-ant-api03-` فده مفتاح API مش توكن اشتراك: Claude Code هيرد بـ «Not logged in». استخدمه بدل كده مع `provider: anthropic` وsecret اسمه `ANTHROPIC_API_KEY`.
>    - الزقه كامل، من غير مسافات ولا علامات تنصيص.
> 4. MergePilot ما بيقراش التوكن ده ولا بيخزنه ولا بيجدده؛ هو فقط بيمرره للأداة الرسمية بصلاحيات قراءة فقط (وفق [ADR-0006](adr/0006-subscriptions-via-official-agent-clis.md)).

السلوك ده خاص بـ `claude-code` في الـ Action. اشتراك Claude في لوحة التحكم بيتخزّن مشفّر وبيتجدّد على السيرفر حسب [ADR-0020](adr/0020-dashboard-subscription-auth.md).

---

### الخطوة 2: أنشئ ملف الإعدادات `.mergepilot.yml`

في جذر المستودع (root)، أنشئ ملفًا باسم `.mergepilot.yml`. اختار أحد النماذج التالية حسب مزودك:

#### مثال 1: Anthropic (Claude API)
```yaml
provider: anthropic
model: claude-3-7-sonnet-20250219
language: ar

review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md
    - AGENTS.md

budget:
  perReviewUsd: 0.5
```

#### مثال 2: OpenAI (GPT)
```yaml
provider: openai
model: gpt-4o
language: ar

review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md

budget:
  perReviewUsd: 0.5
```

#### مثال 3: Google Gemini
```yaml
provider: gemini
model: gemini-2.5-flash
language: ar

review:
  maxFindings: 5
  minSeverity: medium

budget:
  perReviewUsd: 0.2
```

#### مثال 4: Claude Code CLI (اشتراك شخصي)
```yaml
provider: claude-code
# ملاحظة: حقل model اختياري مع claude-code لأن الأداة تختار نموذجها تلقائيًا
language: ar

review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md

budget:
  perReviewUsd: 1.0
  # جدول الأسعار (اختياري لحساب التكلفة التقديرية بالدولار):
  # ملاحظة هامة: الأسعار هي مسؤولية صاحب المشروع لتعبئتها من صفحة أسعار المزود المعتمد لديه.
  pricing:
    inputPerMTok: 3.0
    outputPerMTok: 15.0
```

---

### الخطوة 3: أضف سير العمل (GitHub Actions Workflow)

أنشئ ملفًا في مستودعك بالمسار التالي:
`.github/workflows/mergepilot.yml`

#### أ) إذا كنت تستخدم وضع الـ API (مثل Anthropic أو OpenAI أو Gemini):
لا حاجة لنسخ ملفات المستودع في هذا الوضع، حيث يعتمد المحرك على diff الـ PR مباشرة من واجهة برمجة GitHub:

```yaml
name: MergePilot

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: mergepilot-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Review Pull Request
        uses: lolotam/MergePilot@main
        env:
          # فعّل المفتاح الخاص بالمزود المكتوب في .mergepilot.yml:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          # GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

#### ب) إذا كنت تستخدم وضع الاشتراك عبر أداة Claude Code (`claude-code`):
يحتاج وضع الاشتراك إلى توفر ملفات الـ PR وأداة Claude Code على جهاز التشغيل (Runner)، لذا يتطلب الخطوات الإضافية التالية:

```yaml
name: MergePilot

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: mergepilot-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository
    timeout-minutes: 15
    steps:
      # 1. نسخ كود الـ PR مع الـ head commit وبدون حفظ الـ credentials
      - name: Checkout pull request head
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false

      # 2. إعداد بيئة Node.js 22
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      # 3. تثبيت أداة Claude Code الرسمية
      - name: Install Claude Code CLI
        run: npm install -g @anthropic-ai/claude-code

      # 4. تشغيل MergePilot مع تمرير توكن الاشتراك
      - name: Review Pull Request
        uses: lolotam/MergePilot@main
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

> [!IMPORTANT]
> **لماذا يتم تنظيف وتطهير مجلد العمل (Sanitized Workspace) في وضع Claude Code؟**
> - أداة Claude Code الرسمية تقوم تلقائيًا بقراءة ملفات الإعدادات والتعليمات من مجلد العمل (`cwd`)، مثل `CLAUDE.md` و`CLAUDE.local.md` ومجلد `.claude/` (الإعدادات والـ hooks والأوامر) وملفات `.mcp.json` و`AGENTS.md` و`.cursor/` و`.github/copilot-instructions.md`.
> - بما أن كود الـ PR غير موثوق، فقد يحاول صاحب الـ PR حقن تعليمات خبيثة أو hooks للتأثير على المراجعة.
> - لذلك، يقوم MergePilot بنسخ ملفات المستودع إلى مجلد مؤقت نظيف مع **استبعاد تام** لجميع هذه الملفات على أي عمق، واستبعاد الملفات الحساسة (مثل `.env` والمفاتيح)، وتجاهل الروابط الرمزية (symlinks) تمامًا.
> - قواعد المراجعة يتم تمريرها فقط وبشكل حصري من الفرع الأساسي (Base branch) عبر الـ prompt الموجه للأداة، كما يتم ضبط `CLAUDE_CONFIG_DIR` إلى مجلد مؤقت فارغ لمنع قراءة أي إعدادات للمستخدم على جهاز الـ runner.

---

### الخطوة 4: افتح Pull Request

- افتح أي Pull Request في مستودعك، أو ادفع تحديثات جديدة لـ PR مفتوح.
- سيقوم سير عمل MergePilot بالعمل تلقائيًا.
- سينشر MergePilot مراجعة واحدة تشمل الملخص بالعربي، وملاحظات على السطور المحددة مباشرة.

---

## 3. ماذا يحدث مع طلبات السحب من الـ Forks؟

> [!IMPORTANT]
> **حماية الأسرار والأمان أولًا:**
> - نحن نستخدم حدث `pull_request` القياسي مع صلاحيات مقيدة (`contents: read` و`pull-requests: write`).
> - نحن **لا نستخدم أبدًا** حدث `pull_request_target` لأنه قد يسمح لكود غير موثوق بالوصول إلى مفاتيحك.
> - في GitHub Actions، طلبات السحب القادمة من مستودعات مشتقة (forks) **لا يمكنها الوصول إلى أسرار المستودع** (`secrets.*`).
> - عندما يتم فتح PR من fork بدون توفر المفتاح السري، يقوم MergePilot بتخطي المراجعة بسلام وطباعة رسالة واضحة في سجلات التشغيل، دون التسبب في فشل سير العمل.

---

## 4. جدول حقول الإعدادات (`.mergepilot.yml`)

| الحقل | النوع | الافتراضي | الوصف |
|---|---|---|---|
| `provider` | `enum` | *(إجباري في الـ Action)* | مزوّد API من قايمة `packages/engine/src/providers/ids.ts`، أو `claude-code` للـ Action. في الـ GitHub App اختياري: المزود والنموذج بييجوا من الداشبورد لكل بوت، وأي قيمة هنا بتتجاهل. |
| `model` | `string` | *(إجباري عدا claude-code، واختياري في الـ App)* | اسم النموذج (مثل `claude-3-7-sonnet-20250219` أو `gpt-4o` أو `gemini-2.5-flash`). اختياري فقط مع `claude-code`. |
| `language` | `ar \| en` | `ar` | لغة التعليقات والملخص (`ar` للعربية أو `en` للإنجليزية). |
| `review.maxFindings` | `number` | `5` | الحد الأقصى للملاحظات المنشورة على السطور (بين 1 و 20). |
| `review.maxPromptTokens` | `number` | `60000` | لو حجم الـ PR كله أكبر من كده، المراجعة تتقسم على دفعات من الأول بدل نداء واحد كبير. |
| `review.batchTokens` | `number` | `24000` | أقصى حجم diff (بالتوكنات) في الدفعة الواحدة؛ الملف الأكبر من كده بيتراجع لوحده ومقصوص، وده بيتذكر في الملخص. |
| `review.callTimeoutMs` | `number` | `300000` | أقصى وقت لكل نداء للموديل (5 دقايق)؛ بعده النداء يفشل بـ `TIMEOUT` وسلسلة البدائل تقرر وتعلن. |
| `review.totalTimeoutMs` | `number` | `1200000` | أقصى وقت للمراجعة كلها (20 دقيقة)؛ بعده مفيش دفعات جديدة، وبيتنشر اللي خلص مع ذكر الباقي. |
| `review.minSeverity` | `enum` | `medium` | أقل درجة خطورة تُنشر: `critical`، `high`، `medium`، `low`، `info`. |
| `review.exclude` | `string[]` | `['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap']` | أنماط الملفات المستبعدة من المراجعة. |
| `review.rulesFiles` | `string[]` | `['CLAUDE.md', 'AGENTS.md']` | ملفات القواعد الخاصة بالمشروع التي يقرؤها المحرك ويلتزم بتعليماتها. |
| `review.pathInstructions` | `object[]` | `[]` | تعليمات مخصصة لمسارات معينة (كل عنصر يحتوي على `path` و`instructions`). |
| `budget.perReviewUsd` | `number` | `0.5` | الحد الأقصى التقديري للتكلفة بالدولار للمراجعة الواحدة قبل استدعاء النموذج. |
| `budget.maxInputTokens` | `number` | `200000` | الحد الأقصى لتوكنات الإدخال المسموح بها في المراجعة. |
| `budget.pricing` | `object` | *(اختياري)* | جدول أسعار التوكنات لكل مليون توكن (`inputPerMTok` و `outputPerMTok`). مسؤولية صاحب المشروع ملؤها من صفحة أسعار مزوده لحساب التكلفة الفعلية بالدولار. |
| `audit.enabled` | `boolean` | `false` | تفعيل وضع الفحص الكامل للمستودع دوريًا. |
| `audit.schedule` | `string` | *(اختياري)* | تعبير Cron لجدولة الفحص الكامل الدوري. |

### الأسعار في نسخة الـ SaaS (GitHub App)

في الـ GitHub Action الأسعار بتيجي من `budget.pricing` بس. في نسخة الـ SaaS، MergePilot بيجيب الأسعار تلقائيًا كل يوم من القوايم العامة (OpenRouter وVercel AI Gateway وmodels.dev)، ويختار سعر النموذج بالترتيب ده (ADR-0016):

1. السعر اليدوي اللي حطه أدمن مساحة العمل في الإعدادات (`priceOverrides`).
2. `budget.pricing` في `.mergepilot.yml`، لو الملف بيسمّي نفس المزود والنموذج.
3. السعر اللي اتجاب تلقائيًا.
4. لو مفيش سعر خالص، التكلفة بتفضل «غير معروفة» (مش صفر).

لما السعر يبقى معروف، حد `budget.perReviewUsd` بيتطبّق قبل المراجعة: PR ضخم على نموذج غالي ممكن يتخطى ويتكتب في الملخص إنه اتخطى بسبب الميزانية. والميزانية الشهرية بتحسب التكلفة الحقيقية.

الاشتراك المربوط من لوحة التحكم بيحسب التوكنات، لكن تكلفة API الإضافية بتبقى صفر بدل أسعار الـ API؛ ثمن الاشتراك بيتدفع للمزوّد منفصل. نداءات الحَكَم المدفوعة بتفضل بأسعارها، وتكلفة البديل المدفوع بتفضل غير معروفة حسب قواعد البدائل الحالية.

---

## 5. ملاحظة الخصوصية والأمان

> [!NOTE]
> - **بيانات الكود:** الـ diff وسياق المراجعة بيروحوا للمزوّد والنموذج المختارين ببيانات الدخول النشطة؛ أي بديل لازم يبقى متضبط صراحة وبيظهر في التقرير.
> - **GitHub Action:** المراجعة بتشتغل داخل GitHub Runner، والمفاتيح بتيجي من GitHub Secrets.
> - **GitHub App:** السيرفر بيخزّن الإعدادات وسجلات المراجعة وبيانات الدخول المشفّرة. بيانات الدخول ما بترجعش للواجهة ولا بتدخل الـ prompts والسجلات.
