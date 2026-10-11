export interface ReviewMarker {
  headSha: string;
  configHash: string;
}

const MARKER_REGEX = /<!--\s*mergepilot:review\s+head=([^\s>]+)\s+config=([^\s>]+)\s*-->/;

/**
 * Builds the hidden HTML comment marker used to identify MergePilot reviews idempotently.
 */
export function buildMarker({ headSha, configHash }: ReviewMarker): string {
  return `<!-- mergepilot:review head=${headSha} config=${configHash} -->`;
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
  };
}
