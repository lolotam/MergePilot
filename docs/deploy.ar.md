# دليل تشغيل ونشر MergePilot على خادم Dokploy

هذا الدليل مكتوب بلغة عربية بسيطة ومباشرة لصاحب المشروع، ويشرح خطوة بخطوة بالترتيب كيفية نشر وتشغيل المنصة على سيرفر Dokploy الخاص بك على النطاق:
`mergepilot.walidmohamed.com`

---

## متطلبات أولية سريعة قبل البدء
1. خادم (VPS) مثبت عليه لوحة **Dokploy**.
2. وصول إلى لوحة تحكم النطاق (DNS) الخاص بـ `walidmohamed.com`.
3. حساب GitHub لإنشاء وضبط تطبيق GitHub App.
4. حساب Google Cloud لإنشاء مفاتيح الدخول عبر Google.

بناء المشروع بيستخدم نسخة pnpm الموجودة في `package.json`، والمتطابقة مع `Dockerfile`. التثبيت بـ frozen lockfile، وصورة Node 22 لازم تدعم Node >=22.19.0.

---

## الخطوة 1: ضبط سجل الـ DNS (ربط الدومين بالسيرفر)

1. ادخل إلى لوحة تحكم الدومين الخاص بك (مثلاً Cloudflare أو Namecheap أو مزود الدومين).
2. توجه إلى قسم إدارة السجلات (DNS Management / Records).
3. أضف سجلاً جديداً من نوع **A Record**:
   - **Type:** `A`
   - **Name (Host):** `mergepilot`
   - **Value (IP):** عنوان الـ IP العام الخاص بسيرفر Dokploy (مثلاً: `192.0.2.1`).
   - **TTL:** تلقائي (Auto) أو 300 ثانية.
4. انتظر دقيقة حتى ينتشر السجل وتتأكد أن `mergepilot.walidmohamed.com` يشير إلى سيرفرك.

---

## الخطوة 2: إنشاء المشروع وتطبيق Compose في Dokploy

1. سجّل الدخول إلى لوحة تحكم **Dokploy** على سيرفرك.
2. انقر على **Projects** ثم أنشئ مشروعاً جديداً باسم `MergePilot`.
3. داخل المشروع، انقر على **Add Service** واختر **Compose**.
4. سمّ الخدمة `mergepilot-stack`.
5. في قسم إعدادات الـ Compose:
   - اختر **Raw Compose** أو انسخ محتوى الملف الموجود في المستودع:
     [`deploy/docker-compose.dokploy.yml`](../deploy/docker-compose.dokploy.yml).
   - الصق المحتوى بالكامل في محرر Dokploy.

---

## الخطوة 3: تجهيز ولصق المتغيرات البيئية (Environment Variables)

داخل صفحة الـ Compose في Dokploy، انتقل إلى تبويب **Environment** أو **Variables**، وقم بلصق المتغيرات التالية بعد استبدال القيم بحسب التوضيح:

### 1. توليد المفاتيح السرية (Generated Secrets)
في جهازك أو أي طرفية مثبت عليها Node.js، نفّذ هذا الأمر لإنشاء قيمة عشوائية آمنة:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
نفذ الأمر مرتين:
- المرة الأولى للمتغير: `BETTER_AUTH_SECRET`
- المرة الثانية للمتغير: `MERGEPILOT_MASTER_KEY`

### 2. قيم المتغيرات ومصادرها بالتفصيل

```env
# 1. الرابط الأساسي للخدمة
MERGEPILOT_BASE_URL=https://mergepilot.walidmohamed.com
PORT=3000

# 2. صورة Docker المنشورة من مستودع GitHub Packages (GHCR)
# الصورة مش متغيّر هنا: بتتحدد في سطر x-image في ملف الـ compose (شوف الخطوة 7)

# 3. قواعد البيانات والخدمات الداخلية (ضمن شبكة Dokploy الداخلية)
DATABASE_URL=postgres://postgres:StrongDbPasswordHere@postgres:5432/mergepilot
REDIS_URL=redis://redis:6379
POSTGRES_DB=mergepilot
POSTGRES_USER=postgres
POSTGRES_PASSWORD=StrongDbPasswordHere

# 4. المفاتيح السرية المولدة بالأمر السابق
MERGEPILOT_MASTER_KEY=<المفتاح المولد بالأمر السابق>
BETTER_AUTH_SECRET=<المفتاح المولد بالأمر السابق>

# 5. إعدادات تطبيق GitHub App
# تجدها في: GitHub Settings -> Developer settings -> GitHub Apps -> تطبيقك
GITHUB_APP_ID=<رقم الـ App ID الظاهر في صفحة التطبيق>
GITHUB_APP_SLUG=mergepilot
GITHUB_WEBHOOK_SECRET=<السر الذي أدخلته عند إنشاء الـ Webhook>
GITHUB_CLIENT_ID=<الـ Client ID الظاهر في صفحة التطبيق>
GITHUB_CLIENT_SECRET=<الـ Client Secret المولد في صفحة التطبيق>
GITHUB_APP_PRIVATE_KEY="<المفتاح الخاص PEM المحمل من صفحة التطبيق، احتفظ بالفواصل \n أو ضعه بين علامات تنصيص>"

# 6. إعدادات Google OAuth
# تجدها في: Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client IDs
GOOGLE_CLIENT_ID=<الـ Client ID من منصة جوجل>
GOOGLE_CLIENT_SECRET=<الـ Client Secret من منصة جوجل>

# 7. عدد معالجات الـ Worker المتزامنة
WORKER_CONCURRENCY=8
```

احفظ المتغيرات بالنقر على **Save**.

---

## الخطوة 4: النشر الأول (First Deploy)

1. في لوحة Dokploy، اضغط على زر **Deploy**.
2. سيقوم Dokploy بسحب الصورة (المكتوبة في سطر `x-image` في ملف الـ compose) وتشغيل الحاويات بالترتيب التالي:
   - حاوية `postgres` و `redis` أولاً حتى تصبحا في حالة جاهزية (`healthy`).
   - حاوية `migrate` لتطبيق تعديلات الجداول في قاعدة البيانات مرة واحدة والانتهاء بنجاح (`exited 0`).
   - حاوية `web` لاستقبال الطلبات وتوجيهها عبر Traefik.
   - حاوية `worker` لمعالجة مهام المراجعة في الخلفية.
3. يقوم Traefik تلقائياً بالتواصل مع Let's Encrypt وإصدار شهادة SSL مجانية وتفعيل تشفير HTTPS.

---

## الخطوة 5: التحقق من نجاح النشر وعمل السيرفر

1. افتح متصفح الإنترنت وتوجه إلى الرابط:
   `https://mergepilot.walidmohamed.com/health`
2. يجب أن تظهر لك رسالة JSON تفيد بنجاح الخدمة:
   ```json
   {"ok": true}
   ```
3. تأكد أن علامة القفل الخضراء (HTTPS) تظهر في شريط المتصفح وتفيد بأن شهادة Let's Encrypt تعمل بصورة صحيحة.

### التحقق من تسجيل الاشتراكات

بعد تسجيل الدخول للوحة التحكم، الأدمن أو المالك يقدر يربط اشتراك OpenAI/Codex أو Claude أو Grok من إعدادات بيانات الدخول. ده منفصل عن Google/GitHub اللي بيسجّلوا دخول المستخدم لـ MergePilot. [خطوات الدخول والتجديد](subscription-auth.md).

توكنات المزوّدين بتتخزّن مشفّرة في Postgres، والـ web والـ worker لازم يستخدموا نفس إعدادات الخزنة `MERGEPILOT_MASTER_KEY`. مفيش تثبيت CLI أو فتح منافذ localhost للـ OAuth. لو بتشغّل أكتر من نسخة web، فعّل sticky routing لمسارات `/api/workspaces/*/subscriptions/*` أثناء الدخول. إعادة تشغيل web بتلغي محاولات الدخول المعلّقة، لكن بيانات الدخول المحفوظة بتفضل موجودة.

---

## الخطوة 6: إكمال إعدادات تطبيق GitHub App

الآن بعد أن أصبح السيرفر يعمل ولديه رابط مباشر، توجه إلى إعدادات تطبيق GitHub الخاص بك على الرابط:
`https://github.com/settings/apps/<your-app-slug>`

وقم بتعبئة الحقول التالية:
1. **Homepage URL:**
   `https://mergepilot.walidmohamed.com`
2. **Callback URL (User authorization callback URL):**
   `https://mergepilot.walidmohamed.com/api/auth/callback/github`
3. **Setup URL (Redirect on install):**
   `https://mergepilot.walidmohamed.com/app/installed`
4. **Webhook URL:**
   `https://mergepilot.walidmohamed.com/webhooks/github`
5. **Webhook Secret:**
   تأكد من تطابقه التام مع قيمة `GITHUB_WEBHOOK_SECRET` في Dokploy.
6. تأكد من تفعيل خيار **Active** تحت قسم Webhook ثم احفظ الإعدادات بالضغط على **Save changes**.

---

## الخطوة 7: التحديث والتراجع (Update & Rollback)

كل push على `main` بيبني صورة `ghcr.io/lolotam/mergepilot:<COMMIT_SHA>` الكاملة (40 حرف) عن طريق GitHub Actions.

### الطريقة الحالية: يدوي (لحد ما صاحب المشروع يفعّل النشر التلقائي)

1. **للتحديث:** عدّل سطر `x-image` في `deploy/docker-compose.dokploy.yml` للـ SHA الكامل الجديد (ويُفضّل مع الـ digest)، مثلاً:
   `x-image: &image ghcr.io/lolotam/mergepilot:<SHA>@sha256:<DIGEST>`
   وبعد ما يوصل `main` اضغط **Deploy** في Dokploy.
2. **للتراجع:** رجّع سطر `x-image` للإصدار اللي كان شغال واضغط **Deploy**. ده بيرجّع الصورة بس، مش قاعدة البيانات: لو الإصدار الجديد فيه migration، التراجع محتاج قرار يدوي.
3. النشر **مش zero-downtime**: Compose بيعيد إنشاء `web` و`worker`، والطلبات أو المراجعات اللي شغالة وقتها ممكن تتقطع.

### النشر التلقائي المشروط (ADR-0025، متطبّق بس مش مفعّل)

الـ workflow `.github/workflows/release.yml` بيشتغل بعد ما `CI` و`Integration Tests` و`Docker Image` يخلصوا على push لـ `main`، أو يدوي من تبويب Actions بـ SHA كامل. من غير تفعيل بيعمل **dry run** بس: بيكتب الخطة في ملخص الـ job ومش بيغيّر حاجة.

لما يتفعّل، بينشر الـ commit بس لو:
- الـ checks التلاتة (`check` و`integration` و`Build and Push Docker Image`) نجحت على **نفس الـ SHA**، والـ commit موجود على `main`.
- الصورة بتاعة الـ SHA ده مرفوعة، والـ label `org.opencontainers.image.revision` فيها بيساوي الـ SHA.
- الـ commit أحدث من اللي شغال، ومفيش issue مفتوح عليه label `release-hold`.

commit فيه تغيير توثيق بس بيتخطّى (مفيش صورة جديدة). بعدها بيكتب release commit على فرع `production` فيه الـ pin بالـ digest، ويطلب من Dokploy عمل deploy عن طريق الـ Compose API، ويتأكد إن `migrate` خلص بـ exit 0، و`postgres` و`redis` جاهزين، و`web` و`worker` healthy على نفس الصورة والـ SHA، و`/health` بيرجّع 200 و`{"ok":true}`.

**لو التحقق فشل:** بيفتح issue عليه `release-hold` (وده بيوقف أي نشر بعده لحد ما يتقفل)، ويرجع تلقائياً للإصدار السابق **بس لو مفيش ملف اتغيّر تحت `apps/app/migrations/`**. مش بيمسح volumes، ومش بيعمل downgrade أو restore لقاعدة البيانات أبداً.

**خطوات التفعيل (صاحب المشروع بس):**
1. يعمل فرع `production` على الـ commit الشغال حالياً، ويحوّل مصدر الـ compose في Dokploy لفرع `production` ويقفل autoDeploy.
2. يعمل مستخدم API مخصّص في Dokploy، ويحط مفتاحه في secret اسمه `DOKPLOY_API_KEY` في إعدادات الريبو.
3. يحط الـ variables دي: `DOKPLOY_URL` و`DOKPLOY_COMPOSE_ID` و`DOKPLOY_APP_NAME` (واختياري `PRODUCTION_URL` و`RELEASE_BRANCH` و`DEPLOY_TIMEOUT_MINUTES`).
4. يعمل label اسمه `release-hold` في الريبو.
5. يختار مدة `WORKER_STOP_GRACE_PERIOD` في Environment بتاع Dokploy (الافتراضي 10s، ودي مدة الـ worker عشان يخلّص المراجعات الشغالة قبل ما Docker يقفله).
6. يحط الـ variable `MERGEPILOT_AUTO_RELEASE` = `enabled`.

**الإيقاف:** امسح الـ variable `MERGEPILOT_AUTO_RELEASE` (أو غيّر قيمته)، والـ workflow يرجع dry run. ولإيقاف مؤقت من غير ما تلمس الإعدادات، افتح issue عليه `release-hold`.

---

## الخطوة 8: النسخ الاحتياطي لقاعدة البيانات (Postgres Volume Backups)

بيانات العملاء والمراجعات مخزنة بأمان في مجلد Docker الدائم المسمى `postgres_data`.

### 1. النسخ الاحتياطي عبر Dokploy:
توفر لوحة Dokploy خاصية النسخ الاحتياطي التلقائي (Database Backups) أو مجلدات التخزين (Volumes):
- توجه إلى تبويب **Backups** في التطبيق.
- حدد جدولة يومية أو أسبوعية للنسخ إلى S3 أو التخزين السحابي.

### 2. أخذ نسخة احتياطية فورية يدوياً عبر سطر الأوامر (pg_dump):
إذا أردت تحميل نسخة احتياطية من قاعدة البيانات إلى جهازك في أي وقت، يمكنك تشغيل الأمر التالي من السيرفر:
```bash
docker exec -t mergepilot-postgres pg_dump -U postgres mergepilot > backup-$(date +%F).sql
```
ولاستعادة النسخة عند الحاجة:
```bash
cat backup-2026-10-12.sql | docker exec -i mergepilot-postgres psql -U postgres mergepilot
```

---

## الخطوة 9: قراءة ومتابعة السجلات (Logs) في Dokploy والبحث بـ reqId

تستخدم المنصة نظام تسجيل مهيكل (JSON Structured Logging) لكل من خادم الويب (`web`) ومعالج المهام (`worker`):

### 1. عرض السجلات في Dokploy:
1. داخل صفحة تطبيق الـ Compose في لوحة **Dokploy**، انقر على تبويب **Logs**.
2. يمكنك اختيار الحاوية التي تريد متابعتها من القائمة المنسدلة:
   - **حاوية `web`**: لمتابعة طلبات الـ HTTP القادمة من المستخدمين، وأحداث الـ Webhooks، والتسجيلات الخاصة بالواجهة البرمجية.
   - **حاوية `worker`**: لمتابعة مهام تحليل ومراجعة الكود، استدعاء نماذج الذكاء الاصطناعي (AI Providers)، واستخدام التوكنز والتكلفة.

### 2. البحث عن المشاكل وتتبع الطلبات باستخدام `reqId`:
- كل طلب HTTP يمر بالخادم يحصل على معرف فريد `reqId` يتم إرجاعه في هيدر الاستجابة `x-request-id`.
- عند حدوث أي خطأ أو للإبلاغ عن مشكلة معينة، يمكنك أخذ قيمة الـ `x-request-id` والبحث عنها مباشرة في مربع البحث داخل تبويب **Logs** لحاوية `web`.
- ستظهر لك السجلات الخاصة بهذا الطلب متضمنة:
  - المسار (`path`) ونمط المسار (`route`) بدون معلمات الاستعلام الحساسة.
  - كود الحالة (`statusCode`) ومدة التنفيذ بالمللي ثانية (`durationMs`).
  - معرّف المستخدم (`userId`) ومساحة العمل (`workspaceId`).
  - عند حدوث أخطاء 4xx تظهر كسجل `warn` مع كود الخطأ، وعند حدوث أخطاء 5xx تظهر كسجل `error` مع تفاصيل الخطأ وتتبع المسار (Stack Trace) مع تعتيم أي أسرار تلقائياً.

### 3. تدوير السجلات التلقائي (Log Rotation):
تم ضبط خيارات Docker لحاويتي `web` و `worker` لتدوير ملفات السجلات تلقائياً بمقاس أقصى 10 ميغابايت لكل ملف وبحد أقصى 5 ملفات (`max-size: 10m, max-file: 5`)، مما يضمن بقاء السجلات محدثة ومتاحة دون ملء مساحة القرص الصلب للسيرفر.
