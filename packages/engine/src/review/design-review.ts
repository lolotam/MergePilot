/**
 * Design and spec review mode (ADR-0040): a review call whose changed files are mostly design
 * documents (a spec, a plan, an ADR, a PRD, a design doc or a roadmap) is reviewed as the schema
 * and the code the document will become, not as prose.
 */

import { matchesGlob } from '../diff/glob.js';

/** The paths that count as a design or specification document. */
export const DESIGN_DOC_GLOBS: readonly string[] = [
  'docs/specs/**',
  'docs/adr/**',
  'docs/prd/**',
  '**/spec.md',
  '**/plan.md',
  '**/prd.md',
  '**/roadmap.md',
  '**/*design*.md',
  '**/*design*.mdx',
  '**/spec*.md',
  '**/*-spec*.md',
];

/** True when the path is a design or specification document (ADR-0040). */
export function isDesignDocPath(path: string): boolean {
  const normalised = path.replace(/\\/g, '/').toLowerCase();
  return DESIGN_DOC_GLOBS.some((glob) => matchesGlob(normalised, glob));
}

/**
 * The number of changed lines of a patch: added plus removed. A GitHub patch carries no '+++' or
 * '---' file header, so every line that starts with '+' or '-' is a changed line.
 */
export function countChangedLines(patch: string): number {
  let changed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') || line.startsWith('-')) changed++;
  }
  return changed;
}

/**
 * True when the call reviews design documents: they hold at least half of its changed lines.
 *
 * It is pure and it is called per review call, so a batched review (ADR-0031) decides on the
 * files of its own batch, and a follow-up review (ADR-0030) decides on the files it shows.
 */
export function isDesignReview(files: ReadonlyArray<{ path: string; patch: string }>): boolean {
  let total = 0;
  let design = 0;

  for (const file of files) {
    const changed = countChangedLines(file.patch);
    total += changed;
    if (isDesignDocPath(file.path)) design += changed;
  }

  if (total === 0) return false;
  return design * 2 >= total;
}

/** The system prompt's design section, added when the call is a design review (ADR-0040). */
export const DESIGN_REVIEW_SECTION = `\
DESIGN REVIEW: most changed lines in this call are a design or specification document (a spec, \
plan, ADR, PRD, design or roadmap). Review the text as the schema and code it will become, and \
check:
- keys: primary keys; composite or business-qualified foreign keys (for example tenant plus id); a \
unique key on every foreign-key target;
- constraints and indexes on foreign-key and lookup columns;
- money: integer minor units, overflow of totals, rounding rules for percentages and sums;
- time: the time zone of the business or branch; inclusive or exclusive bounds;
- concurrency: how concurrent writers are serialized, lock order, idempotent retries;
- state machines: every transition defined, terminal states, deferred constraints;
- contradictions between sections of the document, or with an ADR it cites;
- an API or projection field that a later section relies on but no section defines;
- an open question that another section already treats as decided.
Anchor each finding on the changed line that states or omits the rule. A design gap that will \
ship as a data-integrity or money bug is "high" when the quoted document text shows the gap, even \
though no code exists yet.`;

