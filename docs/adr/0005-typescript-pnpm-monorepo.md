# ADR-0005: TypeScript + pnpm monorepo، والمحرك حزمة واحدة فيها فولدرات

- **الحالة:** Proposed
- **مرتبط بـ:** architecture.md §2

## السياق

- DeepSeek Harness مكتوب بـ TypeScript على Node.
- الـ SDKs الرسمية للمزودين التلاتة موجودة لـ TypeScript.
- GitHub Actions بتدعم JavaScript actions بشكل مباشر، ومن غير Docker.
- صاحب المشروع شغال أصلًا بـ TypeScript وpnpm.

## القرار

- **TypeScript (strict)** على **Node 22+**، و**pnpm workspaces**.
- **Zod** للإعدادات ولـ schema الملاحظات.
- **Vitest** للاختبارات.
- الـ Action بيتبني لملف JavaScript واحد مجمّع، وبيشتغل بـ `runs.using: node24`، أو بأحدث نسخة GitHub بتدعمها وقت التنفيذ.
- **`packages/engine` حزمة واحدة فيها فولدرات** (`llm/` و`providers/` و…)، بدل ١٠ حزم من الأول. أي فولدر بيتفصل حزمة لوحده بس لما يبقى ليه مستخدم تاني فعلًا، زي الـ App.

## النتائج

- إعداد أبسط، وبناء أسرع.
- الحدود بين الفولدرات بتتحمي بقاعدة lint على اتجاه الـ imports (architecture.md §3)، مش بحدود الحزم.
