# دليل تشغيل ونشر MergePilot على خادم Dokploy

هذا الدليل مكتوب بلغة عربية بسيطة ومباشرة لصاحب المشروع، ويشرح خطوة بخطوة بالترتيب كيفية نشر وتشغيل المنصة على سيرفر Dokploy الخاص بك على النطاق:
`mergepilot.walidmohamed.com`

---

## متطلبات أولية سريعة قبل البدء
1. خادم (VPS) مثبت عليه لوحة **Dokploy**.
2. وصول إلى لوحة تحكم النطاق (DNS) الخاص بـ `walidmohamed.com`.
3. حساب GitHub لإنشاء وضبط تطبيق GitHub App.
4. حساب Google Cloud لإنشاء مفاتيح الدخول عبر Google.

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
# استبدل COMMIT_SHA برقم الـ commit المراد نشره، مثل: ghcr.io/lolotam/mergepilot:5008209

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
WORKER_CONCURRENCY=2
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

## الخطوة 7: التحديث والتراجع السريع بنقرة واحدة (Update & Rollback)

عندما يدفع فريق التطوير كوداً جديداً إلى المستودع:
1. تقوم الـ GitHub Actions تلقائياً ببناء صورة جديدة ورفعها إلى:
   `ghcr.io/lolotam/mergepilot:<COMMIT_SHA>`
2. **للتحديث:**
   - ادخل إلى Dokploy وافتح تبويب **Environment**.
   - عدّل سطر `x-image` في ملف الـ compose إلى الـ SHA الجديد، مثلاً:
     `x-image: &image ghcr.io/lolotam/mergepilot:abcdef12`
   - احفظ واضغط **Deploy**.
3. **للتراجع الفوري (Rollback):**
   - إذا حدث أي طارئ في الإصدار الجديد، كل ما عليك فعله هو إعادة سطر `x-image` إلى الـ SHA السابق الذي كان يعمل بنجاح.
   - اضغط **Deploy** وسيعود النظام فوراً للإصدار السابق بدون توقف للخدمة.

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

