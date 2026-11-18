# MP67: CI critical path implementation and measurement

## Authority and scope

Owner instruction MP67 (2026-11-18) authorizes applicable CI optimization in a dedicated, reviewed CI PR, separate from product PR #205. The canonical rule is section 67 of `docs/decisions.ar.md`, referenced by `AGENTS.md`. Only the new decision suffix and minimal guide reference are included; root dirty recovery/KEEP work and earlier local decisions remain untouched. The manager retains the existing local `tasks/todo.md` follow-up entry. These changes are proposed for publication, not claimed merged.

Implementation base: `origin/main` at `a56767b26686e1e308278161400a16ee717b5806`. The clean owned branch was fast-forwarded from `e88a214835dd1a0ec02f2c8092726d3a16187fdd` after verifying ancestry. No reset, force operation or new shell worktree was used.

## Saved baseline, not recollected

Raw evidence: [baseline.json](E:/Dev/Validation/mergepilot-ci-20261118/baseline.json), SHA256 `a076d3c6699efd8c08ce3d2db8056d6f632bd4b4c75c5e44765da6c2b41f1b9d`. Parent tracker, read-only during implementation: `F:/Dev/Projects/MergePilot/docs/plans/ci-critical-path-20261118.md`.

Five distinct code PR heads, successful attempt 1 for CI, Integration Tests and Bundle Check on each same head. This does not mean that each PR's first pushed head passed. Samples span 2026-11-04 through 2026-11-14 with evolving code and test counts.

| PR | CI | Integration | Bundle | Gate seconds | Aggregate job minutes |
| --- | --- | --- | --- | ---: | ---: |
| #205 | [43575708066](https://github.com/lolotam/MergePilot/actions/runs/43575708066) | [43575708065](https://github.com/lolotam/MergePilot/actions/runs/43575708065) | [43575708013](https://github.com/lolotam/MergePilot/actions/runs/43575708013) | 810 | 17.23 |
| #202 | [42914643425](https://github.com/lolotam/MergePilot/actions/runs/42914643425) | [42914643448](https://github.com/lolotam/MergePilot/actions/runs/42914643448) | [42914643379](https://github.com/lolotam/MergePilot/actions/runs/42914643379) | 946 | 19.80 |
| #201 | [42467144489](https://github.com/lolotam/MergePilot/actions/runs/42467144489) | [42467144510](https://github.com/lolotam/MergePilot/actions/runs/42467144510) | [42467144470](https://github.com/lolotam/MergePilot/actions/runs/42467144470) | 1005 | 20.93 |
| #199 | [42453128109](https://github.com/lolotam/MergePilot/actions/runs/42453128109) | [42453128115](https://github.com/lolotam/MergePilot/actions/runs/42453128115) | [42453128128](https://github.com/lolotam/MergePilot/actions/runs/42453128128) | 644 | 14.38 |
| #195 | [41920903674](https://github.com/lolotam/MergePilot/actions/runs/41920903674) | [41920903699](https://github.com/lolotam/MergePilot/actions/runs/41920903699) | [41920903783](https://github.com/lolotam/MergePilot/actions/runs/41920903783) | 1018 | 20.88 |

Baseline `n=5`: median gate wall-clock **946 seconds (15m46s)**; median aggregate elapsed job time **19.80 minutes**. The clock runs from earliest workflow creation through latest completion across `check`, `integration` and `check-bundle`. It includes scheduling after workflow creation, excludes queue time before creation, model reviews, security apps and Docker. Job minutes sum elapsed job time; they are not rounded billed minutes or dollars.

The CI unit step dominates at **575–935 seconds**. Typecheck precedes it (22–38 seconds across all saved samples, generally 29–38 seconds), followed by lint (8–14 seconds); incremental build follows tests (3–5 seconds). Integration and bundle already run independently.

Historical cache hits, runner image differences and CPU/RSS/OOM pressure are **unknown**. Success does not prove absence of pressure. Main runs and reruns are excluded from the timing sample. The parent's bounded inventory retained at most 100 records per workflow: CI 66 success / 32 cancelled / 2 failure; integration 93 success / 7 cancelled; bundle 91 success / 6 failure / 3 cancelled, with one rerun record. This is bounded history, not an estimated failure probability.

## Implemented design

- `.github/workflows/ci.yml` keeps the workflow name, PR/main triggers, read permission and cancellation policy. `static` independently installs with the frozen lockfile, typechecks/emits packages, checks the CI TypeScript scripts, lints and builds. It then verifies inventory and runs the focused DB-free workflow/gate tests.
- Two `unit` matrix jobs each get their own `ubuntu-latest` runner, checkout, frozen install and `pnpm typecheck`. Emitted workspace `dist` is required before test imports; it is neither shared nor restored from another job. Both run the complete existing multi-project Vitest selection, partitioned only by `--shard=1/2` or `--shard=2/2`, with `--maxWorkers=2`. `fail-fast: false` preserves both outcomes; no retry, timeout increase, exclusion, dependency or model change is introduced.
- `check` retains its exact required/release name. `if: ${{ always() }}` makes it evaluate completed dependencies despite failures or skips. It requires both `static` and the matrix `unit` result to be exactly `success`; missing, unexpected, failed, cancelled and skipped outcomes are rejected. GitHub's matrix result is successful only if all legs succeed. No outcome is softened by `continue-on-error`. A workflow cancelled by concurrency cannot produce an accepting completed check.
- `scripts/ci/inventory.ts` uses Vitest's `getRelevantTestSpecifications()` for complete discovery and the configured `sequence.sequencer.shard()` for each shard, matching the execution pool. Vitest 5.0.3's `list --filesOnly --shard` bypasses pool sharding, so that CLI is unsuitable as shard proof. Discovery does not import tests or run DB hooks. Project/file identities must form an exact, nonempty, disjoint union: missing files, extras and duplicates fail the static job. Existing backend, web and release/deployment tests remain selected. This verifies file selection, not whether a test contains an existing skip.
- DB-free tests parse the real workflow YAML using the engine's existing declared YAML dependency. They check job dependencies, prerequisites, shard bounds, unfiltered commands and fail-closed gate behavior, including actual CLI exit statuses. Existing release workflow/core tests still verify release compatibility.

The final CI aggregate covers every job in this workflow. Integration, bundle, security/review outcomes and image/release checks retain their existing independent gates; no cross-workflow gate is replaced. Release source and required names stay unchanged. Release HOLD #204 remains in force.

Each producer logs CPU count and RAM capacity plus `actions/setup-node`'s pnpm cache-hit output (`unknown` if absent). GNU time logs user/system CPU seconds, maximum RSS in KiB and elapsed seconds around the workloads. Maximum RSS reflects the largest observed process high-water mark among the timed command and waited-for descendants, not summed simultaneous worker memory. These observations are not a continuous whole-runner memory trace, cgroup OOM monitor or billed-cost measurement. Standard runner setup logs supply image details for future comparison. No environment, credentials or provider requests are dumped.

## Applicability and tradeoffs

Two full-suite shards should shorten the long test path, but file-count partitioning does not guarantee balanced durations. Three dependency installs/typechecks, a static validation step and a final aggregate runner add setup and runner-minute overhead. No speed, cost or reliability improvement is claimed before comparable after runs. Worker count starts at two per isolated runner; any future increase requires measured memory evidence and review.

Browser parallelism: **N/A**. The web suite uses jsdom inside Vitest, so both shards retain its tests. No live browser/E2E job or new service is introduced.

Docker target parallelism: **N/A** for this slice. One runtime image target and its shared build stage remain; no Docker workflow or image coverage changes. The existing deployment compose may pin different revisions of the same runtime image repository for web and worker; that is not another Docker build target. No dedicated staging image build exists to move to main only. Main-only relocation and any reduction in pre-merge coverage are not part of this patch.

## Validation and delivery

Local validation uses pnpm **12.11.2**, `pnpm install --frozen-lockfile --store-dir E:/Dev/pnpm-store` and a validation copy at `E:/Dev/Validation/mergepilot-ci-20261118/implementation-a56767b`. Dependencies, store, build output and inventory receipt stay on `E:/Dev`; the owned source worktree retains only the uncommitted patch. Local Node is v24.21.0; CI remains Node 22. TypeScript, Vitest and product configuration files remain unchanged; the CI scripts receive an explicit no-emit TypeScript CLI check in the static job.

Commands executed from the validation copy:

| Command | Result |
| --- | --- |
| `pnpm --version` / `node --version` | 12.11.2 / v24.21.0 |
| `pnpm install --frozen-lockfile --store-dir E:/Dev/pnpm-store` | Passed; 482 packages reused, no lockfile edit |
| `pnpm typecheck` | Passed; workspace dist emitted before tests |
| `pnpm exec tsc --noEmit --target ES2023 --lib ES2023 --module NodeNext --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck scripts/ci/gate.ts scripts/ci/inventory.ts scripts/ci/workflow.test.ts` | Passed |
| `pnpm lint` | Passed |
| `pnpm build` | Passed; existing Vite warning for chunks larger than 500 kB |
| `pnpm exec vitest run scripts/ci/workflow.test.ts scripts/release/workflow.test.ts scripts/release/core.test.ts --maxWorkers=2` | 3 files, 95 tests passed |
| `node --experimental-strip-types scripts/ci/inventory.ts` | 496 files, two shards of 248, zero duplicates/omissions |
| `git diff --check` (owned source worktree) | Passed |

The saved [shard inventory](E:/Dev/Validation/mergepilot-ci-20261118/shard-inventory.json) records every project/file identity: backend 412, release/deployment/CI 8, web 76. The initial CLI-based inventory attempt failed on duplicates because Vitest's file-only CLI ignores sharding; it was corrected to invoke the execution sequencer and the validation then passed. The successful focused test command was repeated after that correction. No broad unit suite was run locally.

No local Docker, native DB, production, model or provider calls are required. Full unit shard execution and Linux/GitHub orchestration timing remain PR-CI checks; local work is restricted to types, lint, build, focused workflow/release gates and complete shard discovery. Parent source review found no blocking issue in this bounded CI scope. The standalone PR publishes this patch and the minimal canonical-rule additions under the owner's standing instruction. Linux execution, complete shard outcomes and exact-head automated reviews remain CI/PR evidence. HOLD #204 prevents merge/release until separately resolved; this patch does not authorize a deployment or close that hold.

## Follow-up owner and due date

Responsible: **MergePilot manager**. First review due **2026-12-02**. If rollout is later, report available evidence on that date and finish the comparison **14 days after actual rollout**. Parent maintains `tasks/todo.md`; no new timer, service or ongoing monitoring is claimed.

After actual rollout, save **five comparable successful first-attempt PR runs**, retaining failed and cancelled attempts rather than hiding them. Use the same `check` + integration + bundle gate clock and sum all elapsed job durations, including both shards, static and aggregate. Record exact head, test-file count, workflow hash, runner label/image, CPU/RAM observations and cache hit/miss/unknown for every sample. Separate main pushes, reruns and differing runner/cache conditions; baseline unknown fields stay unknown. Keep low volume explicit instead of fabricating a five-run sample.

The single report to Waleed must give before/after sample sizes and medians, absolute seconds/minutes differences and `100 * (after - before) / before` percentages, aggregate runner-minute change, failures/cancellations/retries, observed resource pressure and billing/reliability limits. Reassess shard imbalance or added setup overhead if the measured gate fails to improve.
