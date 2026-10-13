# ADR-0012: مراجعة تراكمية، منع تكرار التعليقات، والتحكم في الإيقاف المؤقت (Incremental Review & Duplicate Suppression)

- **الحالة:** Accepted (صاحب المشروع، 2026-10-12)
- **مرتبط بـ:** Roadmap Step 0.2, Task P0.2

## السياق

في الاستخدام الفعلي (مثل PR #51 الذي حصل على 9 تعليقات لنفس 3 ملاحظات عبر عدة دفعات)، واجهنا مشكلتين رئيسيتين:
1. **إعادة المراجعة بالكامل في كل دفعة (Full re-review noise & cost):** عند دفع التزامات جديدة إلى PR قائم، كان يتم مراجعة كامل فرق الـ PR، مما يزيد من تكلفة التوكنات ووقت التنفيذ بلا داعٍ.
2. **تكرار التعليقات القائمة (Duplicate inline comments):** كان المحرك يعيد طرح الملاحظات نفسها التي نُشرت في دفعات سابقة ولم تُعالج بعد، مما يزعج المطورين ويشتت الانتباه.
3. **غياب آلية إيقاف مؤقت:** لم يكن لدى أصحاب الـ PR وسيلة لإيقاف المراجعات التلقائية أثناء العمل النشط (WIP) أو إعادة الترتيب (rebase).

## القرار

### 1. نطاق المراجعة التراكمية (Incremental Scope)
- عند وجود مراجعة سابقة من MergePilot على الـ PR تحمل العلامة المخفية:
  `<!-- mergepilot:review head=<sha> config=<hash> -->`
  نقوم بمقارنة الالتزامات بين الرأس المراجع السابق والرأس الجديد باستخدام GitHub Compare API (`compareCommitsWithBasehead`).
- نراجع فقط الملفات المتغيرة في نطاق المقارنة، مع ربط أسطر الـ patch بأسطر فرق الـ PR الأصلي (`RIGHT` side patch lines) لضمان وقوع التعليقات السطرية في مواضع صحيحة وصالحة على GitHub.
- الرجوع إلى مراجعة كاملة (Full review fallback) في الحالات التالية:
  - عدم وجود مراجعة سابقة.
  - حدوث force-push أو إعادة كتابة للتاريخ بحيث لا يكون الرأس القديم سلفًا للرأس الجديد (`status !== 'ahead'`).
  - تغير تجزئة الإعدادات (`configHash`).
  - حجم المقارنة كبير جدًا (> 300 ملف) أو غير متاح (404 أو أي خطأ من الـ compare API).
- المراجعة اللي ما خلصتش (فشلت أو اتوقفت بسبب الميزانية) بتتعلم في العلامة بـ `status=partial`:
  `<!-- mergepilot:review head=<sha> config=<hash> status=partial -->`
  ومش بتتاخد أساس للمراجعة التراكمية، علشان الالتزامات اللي ما اتراجعتش تتراجع في الدفعة الجاية.
- لو مفيش جديد (نفس الرأس اتراجع قبل كده، أو الالتزامات الجديدة ما لمستش أي ملف من ملفات الـ PR زي دمج الفرع الأساسي): مفيش استدعاء للموديل ومفيش مراجعة بتتنشر.
- إظهار النطاق المستخدم في ملخص المراجعة:
  (`> Reviewed N new commits since abc1234` أو `> تمت مراجعة N من الالتزامات الجديدة منذ abc1234`).

### 2. منع تكرار التعليقات (Duplicate Suppression)
- قبل نشر المراجعة، يتم جلب تعليقات المراجعة السابقة: تعليقات `publisherLogin`، وكمان تعليقات أي حساب bot تاني (`[bot]`) شايلة بصمة `mp:f` — علشان الـ Action (`github-actions[bot]`) والـ GitHub App ما يكرروش تعليقات بعض. بصمة لصقها إنسان ما بتمنعش أي ملاحظة.
- تضمين بصمة مميزة في كل تعليق سطري:
  `<!-- mp:f=<sha256(path:rule:normalized_title).slice(0, 16)> -->`
- استبعاد أي ملاحظة جديدة تطابق تعليقًا منشورًا بالفعل إذا تحقق:
  - نفس مسار الملف (`path`).
  - تداخل في نطاق الأسطر (`line` و`endLine`).
  - تطابق البصمة (`fingerprint`)، أو تشابه العنوان الموحد (Jaccard token similarity >= 0.7). التشابه بيغطي التعليقات القديمة اللي من غير بصمة، وكمان الموديل لما يعيد صياغة نفس الملاحظة على نفس الأسطر.
- الـ Action والـ worker بيستخدموا نفس الكود في `packages/github`.

### 3. التحكم في الإيقاف والاستئناف (Pause & Resume Control)
- دعم أوامر التعليقات على الـ PR:
  `@mergepilot pause` و`@mergepilot resume`، والبدائل العربية: `@mergepilot إيقاف` و`@mergepilot استئناف`.
- التحقق من صلاحية الكتابة (`write` أو `maintain` أو `admin`) عن طريق collaborator permission API. صاحب الريبو (`OWNER`) مقبول من الـ author_association؛ `MEMBER`/`COLLABORATOR` لوحدهم مش كفاية لأنهم ممكن يكونوا read بس. غير المصرح له بياخد رد مهذب ومفيش أي تغيير.
- تعليقات الـ bots (ومنها ردود MergePilot نفسها) والتعليقات المعدلة بيتم تجاهلها؛ والأمر لازم يكون كلمة مستقلة، فالردود اللي فيها الأمر بين backticks ما بتشغلوش تاني.
- **الـ SaaS:** الـ webhook `issue_comment` (action `created` على PR) لما يكون فيه أمر بيحط job صغيرة (`pause-command`) في نفس طابور `reviews` ويرد فورًا (log: `outcome: queued`)؛ الـ web process ما بيعملش أي كتابة على GitHub. الـ worker بيتحقق من الصلاحية وبينفذ الأمر. التعليقات العادية بتفضل `ignored`.
- فحص الإيقاف في الـ worker بيحصل قبل تحميل أي مفتاح أو استدعاء أي موديل، والـ run بيتسجل `skipped`.
- تتبع حالة الإيقاف عبر:
  - وسم الـ PR: `mergepilot:paused`.
  - علامة الحالة المخفية في التعليقات: `<!-- mergepilot:state paused|active -->`.
- عند وجود الـ PR في حالة إيقاف مؤقت:
  - يتم تخطي المراجعة التلقائية.
  - إرسال إشعار توضيحي مرة واحدة لكل فترة إيقاف يحمل العلامة `<!-- mergepilot:pause-notice -->` (إيقاف جديد بعد استئناف بيبعت إشعار جديد).

## النتائج

**الإيجابي:**
- انخفاض كبير في استهلاك التوكنات وتكلفة مراجعة الـ PRs متعددة الالتزامات.
- القضاء التام على تكرار الملاحظات السطرية عبر الدفعات المتعاقبة.
- تمكين المطورين من التحكم الفوري في مراجعات الـ PRs باللغتين العربية والإنجليزية.

**السلبي والمحاذير:**
- استدعاء إضافي لـ GitHub Compare API وجلب تعليقات الـ PR السابقة (مكالمات خفيفة ومحدودة مقارنة بتوفير تكلفة الـ LLM).
- في حالة force-push يعود النظام تلقائيًا للمراجعة الكاملة لضمان الدقة وتجنب فقدان أي تغييرات.

## Amendment (2026-10-13): base-branch merges are not the PR's changes

Seen on lolotam/MergePilot#96, #97 and #103: after the author ran `git merge origin/main`, the incremental review looked at what main had changed, such as another PR's decisions-log entry, as if it were the PR's own work. It then reported that "the patch does not match the description".

The incremental file set was already limited to files in the PR's own diff. A file that both the PR and main touched, however, still carried the full compare patch, main's hunks included.

**What changes.** For each such file, only the compare hunks that belong to the PR are kept (`packages/github/src/own-hunks.ts`). A hunk is the PR's when one of its non-blank added or removed lines is also added or removed in the PR's own diff (base...head).

Main's changes reach the branch through the merge, so they are on the base and never in that diff:
- a merge-only push leaves nothing new to review;
- a merge plus a real change reviews only the real change.

**When nothing is dropped:**
- a hunk with only blank-line changes is kept;
- when GitHub omits the PR patch because the file is too large, the whole compare patch is kept.
