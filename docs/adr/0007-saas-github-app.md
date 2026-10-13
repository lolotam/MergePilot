# ADR-0007: SaaS على شكل GitHub App — مستخدمين متعددين، دخول بـ Google وGitHub، وصلاحيات

- **الحالة:** Accepted (صاحب المشروع، 2026-10-11 — «عملاء من أول يوم (SaaS كامل)»، «سيرفر Dokploy»، «multiuser and auth and authorization with providers google and GitHub»)
- **مرتبط بـ:** ADR-0001 (غلاف تاني على نفس المحرك)، ADR-0002، ADR-0006

## السياق

صاحب المشروع عايز أي عميل يقدر يعمل 3 حاجات:

- يركّب MergePilot على حساب GitHub بتاعه، ويختار **كل الريبوهات أو ريبوهات معينة**.
- **يسجّل دخول بـ Google أو GitHub.**
- يشتغل مع فريق، وكل واحد في الفريق بصلاحيات مختلفة.

الاستضافة على Dokploy، على `mergepilot.walidmohamed.com`.

## القرار

`apps/app` غلاف تاني على `packages/engine` و`packages/github`. فيه:

| الجزء | الاختيار |
|---|---|
| سيرفر HTTP | **Fastify** (عشان webhook محتاج raw body) |
| تسجيل الدخول | **Better Auth**: social providers **Google** و**GitHub**، وإضافة **organization** للمساحات والأدوار والدعوات |
| قاعدة البيانات | **Postgres + Drizzle**، والاختبارات بتستخدم **PGlite** (Postgres جوه العملية) |
| الطابور | **Redis + BullMQ** |
| GitHub | **GitHub App** (`@octokit/app`)، والتوكنات بتاعته بتعيش وقت قصير لكل تركيب |
| المفاتيح | **envelope encryption** بـ AES-256-GCM. المفتاح الرئيسي في متغير `MERGEPILOT_MASTER_KEY` جوه أسرار Dokploy بس، وكل سجل عليه رقم نسخة المفتاح عشان نقدر نغيّره |

### المساحات والأدوار

- كل عميل عنده **مساحة عمل** (organization في Better Auth).
- **أدوار:**
  - `owner`: كل حاجة، ومعاها حذف المساحة.
  - `admin`: إدارة الأعضاء، والمفاتيح، والريبوهات، والإعدادات.
  - `member`: يشوف المراجعات والتكلفة بس.
- **ربط تركيب GitHub بمساحة:** بيحصل لما مستخدم داخل بحساب GitHub مربوط يثبت إنه يقدر يوصل للتركيب، عن طريق user token وقائمة تركيباته. لو المستخدم داخل بـ Google، لازم يربط حساب GitHub الأول.
- **كل استعلام على بيانات العملاء بيتعمل جوه مساحة واحدة.** الوصول لمساحة تانية بيترفض، وعليه اختبارات سلبية.

### المزودين في الـ SaaS

- **مفاتيح API أو اشتراكات OpenAI/Codex وAnthropic/Claude وxAI/Grok** من لوحة التحكم، ببيانات دخول مشفّرة ([ADR-0020](0020-dashboard-subscription-auth.md)).
- **`claude-code`** بيفضل وضع تشغيل CLI خاص بالـ Action. اشتراك Claude في الـ SaaS بيستخدم بروتوكول pi-ai، من غير تشغيل CLI.

### المسار

```
GitHub webhook → التحقق من X-Hub-Signature-256 على الـ raw body
  → منع تكرار X-GitHub-Delivery → حفظ → BullMQ → worker
  → توكن التركيب → إعدادات المساحة + فك تشفير المفتاح
  → reviewPullRequest (نفس منطق الـ Action) → نشر → تسجيل التشغيل والتكلفة
```

## النتائج

**الإيجابي:**

- العميل بيركّب مرة واحدة، وكل الريبوهات بتتراجع.
- فيه فرق بأدوار مختلفة.
- المحرك نفسه ماتغيّرش.

**السلبي:**

- إحنا بقينا مسؤولين عن أسرار العملاء وعزلهم عن بعض.
- لازم نتابع تشغيل السيرفر بنفسنا.

**تبعيات جديدة (بقرار في الـ ADR ده):** `fastify`، `better-auth`، `drizzle-orm`، `drizzle-kit`، `pg`، `@electric-sql/pglite` (للاختبارات)، `bullmq`، `ioredis`، `@octokit/app`.
