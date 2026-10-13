export interface ReviewMarker {
  headSha: string;
  configHash: string;
  /**
   * `partial` when the review did not complete (failed or skipped for budget). A partial review
   * never serves as the base of an incremental review, so its commits are reviewed again later.
   */
  status?: 'partial' | undefined;
  /**
   * The reviewer-panel bot that published the review (ADR-0017), 2-5. Absent for the main bot
   * (slot 1): slot 1 never writes `bot=`, so reviews from before the panel stay slot 1.
   */
  bot?: number | undefined;
}

/** The main bot's slot; a marker or comment without a bot slot belongs to it. */
export const MAIN_BOT_SLOT = 1;

const MARKER_REGEX =
  /<!--\s*mergepilot:review\s+head=([^\s>]+)\s+config=([^\s>]+)(?:\s+status=(partial))?(?:\s+bot=(\d{1,2}))?\s*-->/;

/** Only a bot marker at the very end of a comment counts: it is appended after the fingerprint. */
const COMMENT_BOT_REGEX = /<!--\s*mergepilot:bot=(\d{1,2})\s*-->\s*$/;

const isExtraSlot = (slot: number | undefined): slot is number =>
  typeof slot === 'number' && Number.isInteger(slot) && slot > MAIN_BOT_SLOT;

/**
 * Builds the hidden HTML comment marker used to identify MergePilot reviews idempotently.
 */
export function buildMarker({ headSha, configHash, status, bot }: ReviewMarker): string {
  const statusPart = status ? ` status=${status}` : '';
  const botPart = isExtraSlot(bot) ? ` bot=${bot}` : '';
  return `<!-- mergepilot:review head=${headSha} config=${configHash}${statusPart}${botPart} -->`;
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
  const bot = match[4] ? Number(match[4]) : undefined;
  return {
    headSha,
    configHash,
    ...(match[3] === 'partial' ? { status: 'partial' as const } : {}),
    ...(isExtraSlot(bot) ? { bot } : {}),
  };
}

/** The bot slot of a parsed review marker: 1 when it carries none. */
export function markerBotSlot(marker: ReviewMarker): number {
  return marker.bot ?? MAIN_BOT_SLOT;
}

/** The hidden marker an extra bot appends to its inline comments; empty for the main bot. */
export function buildBotCommentMarker(slot: number | undefined): string {
  return isExtraSlot(slot) ? `<!-- mergepilot:bot=${slot} -->` : '';
}

/** The bot slot of an inline comment: its trailing bot marker, or 1 when it has none. */
export function commentBotSlot(body: string | null | undefined): number {
  const match = body?.match(COMMENT_BOT_REGEX);
  const slot = match?.[1] ? Number(match[1]) : undefined;
  return isExtraSlot(slot) ? slot : MAIN_BOT_SLOT;
}
