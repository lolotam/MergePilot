import { SEVERITY_RANK, type Finding, type Severity } from '../review/types.js';

export interface SelectFindingsOptions {
  maxFindings?: number | undefined;
  minSeverity?: Severity | undefined;
}

/** Code-point order, so ties break the same way on every machine regardless of locale. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBetterCandidate(candidate: Finding, current: Finding): boolean {
  const rankDiff = SEVERITY_RANK[candidate.severity] - SEVERITY_RANK[current.severity];
  if (rankDiff !== 0) {
    // Lower number is higher severity (critical: 0 < info: 4)
    return rankDiff < 0;
  }

  const confDiff = candidate.confidence - current.confidence;
  if (confDiff !== 0) {
    return confDiff > 0;
  }

  const titleDiff = compareText(candidate.title, current.title);
  if (titleDiff !== 0) {
    return titleDiff < 0;
  }

  return compareText(candidate.id, current.id) < 0;
}

function compareFindings(a: Finding, b: Finding): number {
  const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rankDiff !== 0) {
    return rankDiff;
  }

  const confDiff = b.confidence - a.confidence;
  if (confDiff !== 0) {
    return confDiff;
  }

  const pathDiff = compareText(a.path, b.path);
  if (pathDiff !== 0) {
    return pathDiff;
  }

  const lineDiff = a.line - b.line;
  if (lineDiff !== 0) {
    return lineDiff;
  }

  const titleDiff = compareText(a.title, b.title);
  if (titleDiff !== 0) {
    return titleDiff;
  }

  return compareText(a.id, b.id);
}

/**
 * Filters, deduplicates, sorts, and caps findings according to PRD v0.2 §7 step 8.
 *
 * 1. Drops findings below `minSeverity`.
 * 2. Deduplicates findings with the same path, side, line, and normalized title (lowercased,
 *    whitespace collapsed), keeping the one with higher severity, then higher confidence,
 *    breaking ties deterministically.
 * 3. Sorts by severity rank ascending (critical first), then confidence descending,
 *    then path ascending, then line ascending.
 * 4. Caps the resulting list at `maxFindings`.
 *
 * Pure function: does not mutate the input array.
 */
export function selectFindings(
  findings: readonly Finding[],
  opts: SelectFindingsOptions = {},
): Finding[] {
  const minRank = opts.minSeverity !== undefined ? SEVERITY_RANK[opts.minSeverity] : undefined;

  // 1. Filter below minSeverity and 2. Deduplicate
  const dedupedMap = new Map<string, Finding>();

  for (const finding of findings) {
    if (minRank !== undefined && SEVERITY_RANK[finding.severity] > minRank) {
      continue;
    }

    const key = `${finding.path}\0${finding.side}\0${finding.line}\0${normalizeTitle(finding.title)}`;
    const existing = dedupedMap.get(key);

    if (!existing || isBetterCandidate(finding, existing)) {
      dedupedMap.set(key, finding);
    }
  }

  // 3. Sort
  const result = Array.from(dedupedMap.values()).sort(compareFindings);

  // 4. Cap at maxFindings
  if (opts.maxFindings !== undefined) {
    const cap = Math.max(0, opts.maxFindings);
    return result.slice(0, cap);
  }

  return result;
}
