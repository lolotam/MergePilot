/**
 * The parameterized candidates of a crawl (ADR-0052 section 3).
 *
 * The active check needs links that carry query parameters: a baseline GET of
 * the link and a probe of the same link with a changed value. Those links are
 * not pages the crawler read — they are *candidates*, discovered on a page and
 * kept for the check.
 *
 * The ledger is bounded on purpose. A page may carry an arbitrary number of
 * links, and a scan must never hold more of them than the administrator
 * approved: the ledger keeps at most `maxActiveLinks` candidates and reports
 * that it dropped the rest.
 *
 * The raw URL of a candidate never leaves the package. It carries query
 * values, and query values never reach a result, a progress event or the
 * dashboard.
 */

/** One authorized parameterized link a check may look at. */
export interface ScanCandidate {
  /** The URL of the link. Transient: it never leaves this process. */
  readonly url: string;
  /** The exact path of the link. */
  readonly path: string;
  /** The identity of the baseline URL of the link. */
  readonly targetKey: string;
  /** The names of the query parameters the link carries. */
  readonly parameterNames: readonly string[];
}

/** A bounded ledger of candidates. */
export interface CandidateLedger {
  /** The candidates that were kept. */
  readonly candidates: readonly ScanCandidate[];
  /** Whether a candidate was dropped because the ledger was full. */
  readonly truncated: boolean;
  /**
   * Keeps a candidate.
   *
   * Two links that differ only in a query value are two candidates: they are
   * two different baseline requests, and the raw link is what identifies them.
   */
  readonly keep: (candidate: ScanCandidate) => void;
}

/** Creates a bounded ledger of candidates. */
export function createCandidateLedger(cap: number): CandidateLedger {
  const kept: ScanCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;
  return {
    get candidates(): readonly ScanCandidate[] {
      return kept;
    },
    get truncated(): boolean {
      return truncated;
    },
    keep(candidate: ScanCandidate): void {
      if (seen.has(candidate.url)) {
        return;
      }
      if (kept.length >= cap) {
        truncated = true;
        return;
      }
      seen.add(candidate.url);
      kept.push(candidate);
    },
  };
}
