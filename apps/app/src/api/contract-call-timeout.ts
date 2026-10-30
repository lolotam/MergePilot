import { z } from 'zod';

/**
 * The optional per-bot review call timeout override, in milliseconds (the accepted REST bounds;
 * the engine default is 300000 and a repository's `review.callTimeoutMs` outranks it).
 * On writes, omission preserves the stored override and null resets to inheritance.
 * Extra bots inherit the repository/engine value, never the main bot's override.
 */

/** Smallest accepted per-bot call timeout, in ms (inclusive). */
export const CALL_TIMEOUT_MIN_MS = 1000;
/** Largest accepted per-bot call timeout, in ms (inclusive). */
export const CALL_TIMEOUT_MAX_MS = 1200000;

/** Optional nullable per-bot call timeout override in ms (1000-1200000 inclusive). */
export const CallTimeoutMsSchema = z
  .number()
  .int()
  .min(CALL_TIMEOUT_MIN_MS)
  .max(CALL_TIMEOUT_MAX_MS)
  .nullable();
export type CallTimeoutMs = z.infer<typeof CallTimeoutMsSchema>;
