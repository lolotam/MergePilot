/**
 * What the Jev judge is used for (ADR-0015 amendment «multi-use»): zero or more of
 * - `annotate`: a "Jev confidence" line on every posted finding the judge scored;
 * - `filter`: drop findings below the threshold (never critical/high);
 * - `dedupe`: the semantic duplicate check against the same bot's existing comments (ADR-0017);
 * - `consensus`: in the reviewer panel's consensus mode, whether two bots' findings are the same issue.
 */
export const JUDGE_USES = ['annotate', 'filter', 'dedupe', 'consensus'] as const;
export type JudgeUse = (typeof JUDGE_USES)[number];
export type JudgeUses = ReadonlySet<JudgeUse> | readonly JudgeUse[];

/**
 * The single mode used before multi-use. Still accepted from `.mergepilot.yml` and from older web
 * bundles, and mapped by `judgeUsesFromMode`.
 */
export const JUDGE_MODES = ['off', 'annotate', 'filter'] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export function isJudgeUse(value: unknown): value is JudgeUse {
  return typeof value === 'string' && (JUDGE_USES as readonly string[]).includes(value);
}

/** Uses without repeats, in the fixed `JUDGE_USES` order (so stored and compared values are stable). */
export function normalizeJudgeUses(uses: Iterable<JudgeUse>): JudgeUse[] {
  const set = new Set(uses);
  return JUDGE_USES.filter((use) => set.has(use));
}

/**
 * The old single mode as uses. The semantic duplicate check always ran when the judge was on,
 * whatever the mode, so every mode keeps `dedupe`: `off` → dedupe only.
 */
export function judgeUsesFromMode(mode: JudgeMode): JudgeUse[] {
  if (mode === 'annotate') return ['annotate', 'dedupe'];
  if (mode === 'filter') return ['filter', 'dedupe'];
  return ['dedupe'];
}

/** The closest old single mode, for the legacy column kept one release for rollback. */
export function legacyJudgeMode(uses: JudgeUses): JudgeMode {
  if (hasJudgeUse(uses, 'filter')) return 'filter';
  if (hasJudgeUse(uses, 'annotate')) return 'annotate';
  return 'off';
}

export function hasJudgeUse(uses: JudgeUses, use: JudgeUse): boolean {
  return 'has' in uses ? uses.has(use) : uses.includes(use);
}

/** "annotate, filter, dedupe" — or "none" for an enabled judge with nothing to do. */
export function describeJudgeUses(uses: JudgeUses): string {
  const list = normalizeJudgeUses(uses);
  return list.length > 0 ? list.join(', ') : 'none';
}
