export interface ReviewMarker {
  headSha: string;
  configHash: string;
  /**
   * `partial` when the review did not complete (failed or skipped for budget). A partial review
   * never serves as the base of an incremental review, so its commits are reviewed again later.
   */
  status?: 'partial' | undefined;
}

const MARKER_REGEX =
  /<!--\s*mergepilot:review\s+head=([^\s>]+)\s+config=([^\s>]+)(?:\s+status=(partial))?\s*-->/;

/**
 * Builds the hidden HTML comment marker used to identify MergePilot reviews idempotently.
 */
export function buildMarker({ headSha, configHash, status }: ReviewMarker): string {
  const statusPart = status ? ` status=${status}` : '';
  return `<!-- mergepilot:review head=${headSha} config=${configHash}${statusPart} -->`;
}

/**
 * Parses the hidden review marker from a review body. Returns null when absent.
 */
export function parseMarker(body: string | null | undefined): ReviewMarker | null {
  if (!body) {
    return null;
  }
  const match = body.match(MARKER_REGEX);
  if (!match) {
    return null;
  }
  const headSha = match[1];
  const configHash = match[2];
  if (!headSha || !configHash) {
    return null;
  }
  return {
    headSha,
    configHash,
    ...(match[3] === 'partial' ? { status: 'partial' as const } : {}),
  };
}
