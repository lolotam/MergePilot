# ADR-0015: Jev Judge — A "System One" Decision Layer With an Explicit Fallback Chain

- **Status:** Accepted (2026-10-13); the filter's default threshold and never-filtered categories amended by ADR-0028
- **Related to:** ADR-0002, ADR-0008, ADR-0010, ADR-0011, ADR-0013, docs/decisions.ar.md (batch 9, Q26–Q27; batch 12, Q32)

## Context

The owner asked to add TypeSafe's Jev model as a judge layer. Jev is a "System One" decision
model: it does not write text. It takes a `state` and typed questions and returns calibrated
answers: `noul` (a 0–1 probability), `choice` (an option with its probabilities) or `score` (a
level on a rubric). It is billed on input tokens only. TypeSafe's guidance: code owns the control
flow, ask many narrow questions in one request, put only the needed context in `state` and point
at it with backticked paths, act on confident answers.

Four providers serve the same wire format (`POST {base}/v1/systemone`, Bearer key): TypeSafe
itself, OpenRouter, Vercel AI Gateway and OpenCode Zen. The owner wants only Jev models offered on
each, and later asked for a fallback chain so a failed judge provider does not lose the request.

## Decision

1. **Engine module `packages/engine/src/judge/`.**
   - `providers.ts` is the one table of providers, fixed base URLs, Jev-only model ids (default
     first), known input prices, and the Action's env names. Base URLs are never user-overridable
     (same rule as the ADR-0008 amendment and ADR-0010).
   - `call.ts` sends one request. 429 and 529 are retried once after a short backoff (`retry-after`,
     capped at 5 s). Each attempt has a 20 s timeout. Usage is read as `input_tokens` or
     `inputTokens`, and Vercel's `providerMetadata.gateway.cost` is read too. A 422 body's field
     names reach the message, with the key redacted.
   - `judge.ts` holds `createJudge({ entries })` and `judge.decide(...)`, the API the coming reviewer
     panel can reuse.
   - `questions.ts` has the question builders. All PR-derived text in `state` passes through
     `redactSecrets` and `escapeDelimiters` and is capped.
2. **Explicit fallback chain (follows ADR-0008).**
   - **Entries.** The configured judge plus up to three `{provider, model}` fallbacks, each
     limited to the Jev-only table.
   - **When it moves to the next entry:**
     - auth (401/403);
     - rate limit or overload (429/529), after the one retry;
     - 5xx, network or timeout;
     - 422 or 404 (a wrong model id);
     - a malformed reply.
   - **When it does not move on:** a valid answer with low confidence. That is a real answer.
   - **Skipped entries.** An entry without a key is skipped and recorded as `no-key`.
   - **Time budget.** All attempts of one request share 60 s; when it runs out, the result is
     recorded as `time-budget`.
   - **Sticky.** Once a fallback answers, it is used for the rest of the review.
   - **Disclosure.** Every attempt is recorded as `{provider, model, ok, code, ms}`. The summary
     names the judge that answered, e.g.
     `Jev: opencode-zen:jev-1.13-free (fallback 2; openrouter failed: rate-limited)`.
3. **Use case 1: the false-positive filter.**
   - **Where.** In `runReview`, after the verify pass, on the model's findings.
   - **One request per review.** It holds one `noul` per finding: "is this a real problem in the
     shown code?". The state has the finding and its patch hunk.
   - **`annotate` mode** appends `Jev confidence: 0.82` to the comment body.
   - **`filter` mode** drops findings strictly below `threshold` (default 0.35). They are listed in
     a collapsible "Filtered by Jev (n)" section of the summary.
   - **`off` mode** skips the filter (the default for new workspaces).
4. **Use case 2: the semantic duplicate check.**
   - **Where.** Inside `deduplicateFindings`, and only for new findings that the fingerprint and
     title checks did not match.
   - **Candidates.** Existing MergePilot comments on the same path within ±10 lines, at most 3 per
     finding and 50 pairs.
   - **One request.** It holds one `noul` per pair; at ≥ 0.8 the new finding is dropped.
   - **When it runs.** Whenever the judge is enabled, including mode `off`.
5. **No silent fallback.**
   - If every entry fails, the findings are published unchanged.
   - The summary says `Jev judge unavailable: <code>`, and so do the run detail and the logs.
   - The judge never switches providers except through the configured chain.
6. **Cost.**
   - The tokens of every billed attempt go into the run's `result.usage`, so they reach
     `workspace_usage_monthly` too. The judge's own tokens and cost are in `result.judge`.
   - A cost is added only when it is known: Vercel reports one, and `jev-1.13-free` is priced
     at 0.
   - Before a call, an entry with a known price whose estimate exceeds the per-review budget left
     is skipped as `budget`.
7. **SaaS.**
   - **Migration 0007** adds `judge_enabled`, `judge_provider`, `judge_model`, `judge_mode`,
     `judge_threshold` and `judge_fallback` (jsonb, at most 3).
   - **Keys.** `typesafe` and `vercel-gateway` are key-only providers. They are stored and
     encrypted like every key, but they are never review providers.
     *Note (2026-10-13):* `vercel-gateway` is no longer key-only. It is a full review provider
     (ADR-0008 amendment, س31), so its one stored key serves review models on `/v1` and the judge,
     like `openrouter` and `opencode-zen`. The judge still offers only `typesafe-ai/jev` for it,
     and `typesafe` is now the only key-only provider.
   - **Settings.** They take a `judge` object, which the API validates against the Jev-only table.
     An enabled judge needs its own key; a fallback may lack a key and is skipped at run time.
   - **Routes.** `GET /judge/providers` (members) serves the table, and `POST /judge/test` (admins)
     sends one tiny `noul`.
   - **Worker logs.** The worker logs one `judge.call` line per attempt, and never the state.
8. **Action.**
   - **Config.** `.mergepilot.yml` takes a strict `judge:` section.
   - **Keys.** They come from `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY` and
     `OPENCODE_API_KEY`.
   - **Logs.** Each attempt logs one `judge.call` line.

## Consequences

- One request per use case per review keeps the judge cheap. Its tokens and known cost count
  against the per-review and monthly budgets.
- **OpenRouter model id.** `~typesafe/jev-latest` was not verified against the live API. A wrong
  id shows as the provider's own 4xx message in the key test, and moves a review on to the next
  fallback. Fixing it is a one-line change in `JUDGE_PROVIDERS`.
- **Shared summary line.** A judge failure never fails a review. It appears only as the summary
  line and the run record.

## Amendment (2026-10-13): filter limits and disclosure

- **Critical and high findings are never filtered.** The judge's state includes the reviewed code,
  and that code could try to steer the answer. In `filter` mode, a critical or high finding below
  the threshold stays published with its "Jev confidence" line. Only medium, low and info findings
  can be filtered out, and every filtered finding is listed in the summary.
- **A sticky fallback stays disclosed.** After a fallback answers, later requests in the same review
  start at that fallback. `answeredBy.before` lists every entry that failed or was skipped during
  the whole review, not only during the current request.
- **The two judge failures are disclosed separately.** If the false-positive filter fails, the
  summary says the review was published unfiltered. If only the semantic duplicate check fails, the
  summary says "Jev duplicate check unavailable" instead.

## Amendment (2026-10-13): multi-use («multi-use»)

**Context.** The owner asked to use Jev for several purposes at once (decisions log, س32). The
single `mode` (`off | annotate | filter`) could not give "annotate everything + filter + dedupe"
together, and `off` was confusing because the duplicate check still ran. Live, he ticked "Enable"
but left the separate "Mode" select on its default "Off", so the filter never ran.

**Decision.**

1. **Uses replace the mode.** `JudgeUse = 'annotate' | 'filter' | 'dedupe' | 'consensus'`
   (`JUDGE_USES`, `packages/engine/src/judge/uses.ts`). A judge has a set of zero or more uses:
   - `annotate`: a "Jev confidence: 0.82" line on every posted finding the judge scored;
   - `filter`: drops findings below `threshold`. Critical and high are never dropped (first
     amendment); low-confidence findings that are kept get the confidence line;
   - `dedupe`: the semantic duplicate check (use case 2). It now runs only when this use is on;
   - `consensus`: for the coming reviewer panel, to decide whether two bots' findings are the same
     issue. It is stored and validated now, and nothing reads it yet.
2. **One request.** `annotate` and `filter` share the one false-positive request per review. With
   both on, findings are filtered and every remaining finding gets its confidence line. Without
   either, no false-positive request is sent.
3. **Enabled and idle.** `enabled: false` means nothing runs, whatever the uses. An empty set with
   `enabled: true` is allowed: the judge is idle and the settings card shows an amber warning.
   Switching "Enable" on while the set is empty pre-selects `annotate` + `dedupe`.
4. **The old mode is still accepted** in `.mergepilot.yml` `judge:` and on `PUT /settings` (older
   web bundles), mapped so today's behaviour is kept (the duplicate check always ran):
   `off` → `[dedupe]`, `annotate` → `[annotate, dedupe]`, `filter` → `[filter, dedupe]`. When both
   are given, `uses` wins. A `judge:` section with neither keeps the old default (`[dedupe]`). The
   API needs one of the two and rejects unknown uses (400).
5. **Disclosure.** The review summary names the configured uses (`Jev uses: filter, dedupe`), the
   run record stores `uses` (older runs keep `mode`), and the Action logs them.
6. **SaaS.** Migration 0010 adds `workspace_settings.judge_uses text[] NOT NULL DEFAULT '{}'`,
   with a CHECK that each element is one of the four uses, and backfills it from `judge_mode` with
   the mapping above. `judge_mode` stays for one release so a rollback still works. The app no
   longer reads it and writes the closest old mode there (filter, else annotate, else off).

**Consequences.** The owner can turn on any combination without a second Jev call. A judge whose
uses are all off costs nothing. Decision 4's "whenever the judge is enabled, including mode `off`"
no longer holds: the duplicate check needs `dedupe`.
