# MergePilot

مراجعة Pull Requests بالذكاء الاصطناعي، **متعددة المزودين**: بمفتاح API بتاعك، أو باشتراك ChatGPT / Claude / Grok من لوحة التحكم.

- ملخص بالعربي.
- ملاحظات قليلة ومتحقَّق منها على السطور.
- بيفهم قواعد مشروعك (`CLAUDE.md` و`AGENTS.md`).
- بيقارن الكود بتوثيق نفس نسخ المكتبات اللي بتستخدمها.

> **الحالة:** GitHub Action وGitHub App شغّالين، ومعاهم لوحة تحكم وworkers. لوحة التحكم بتدعم API keys واشتراكات ChatGPT / Claude / Grok.

## الوثائق

- [وثيقة الحالة الحالية v0.3](docs/prd/v0.3.ar.md)، والتخطيط السابق [v0.2](docs/prd/v0.2.ar.md) و[v0.1](docs/prd/v0.1.ar.md)
- [المعمارية](docs/architecture.md)
- [قرارات المعمارية (ADRs)](docs/adr/)
- [سجل قرارات صاحب المشروع](docs/decisions.ar.md)

## المبادئ

1. **مفاتيح API أو تسجيل دخول بالاشتراك.** لوحة التحكم بتوفّر الطريقتين لـ OpenAI وAnthropic وxAI. توكنات الاشتراك بتتشفّر بنفس خزنة المفاتيح وبتتجدّد تلقائيًا. [تفاصيل تسجيل الدخول](docs/subscription-auth.md).
2. **مفيش تنفيذ لكود الـ PR** أثناء المراجعة.
3. **محرك واحد، وكذا غلاف:** GitHub Action وGitHub App بيستخدموا نفس المحرك.

## الاستخدام (Usage)

- [دليل الاستخدام السريع (عربي)](docs/usage.ar.md)
- [مثال سير عمل GitHub Actions](examples/workflows/mergepilot.yml)
