import { LlmFailure } from '../llm/failure.js';

/**
 * Same provider and same model, next API key only (ADR-0026). This is not the
 * model/provider fallback of ADR-0008: the call advances only when the failure
 * is a quota or rate limit. Every other failure is returned as-is.
 */

/** Indexes to try, starting at `startIndex` and wrapping once. Each index appears once. */
export function rotationOrder(length: number, startIndex: number): number[] {
  if (length <= 0) return [];
  const start = ((Math.trunc(startIndex) % length) + length) % length;
  return Array.from({ length }, (_, offset) => (start + offset) % length);
}

/** Quota or rate limit, after the adapter has finished its own retries. */
export function isRotatingFailure(error: unknown): error is LlmFailure {
  return error instanceof LlmFailure && (error.code === 'QUOTA' || error.code === 'RATE_LIMIT');
}

export interface KeyRotationEvent {
  provider: string;
  /** 0-based index of the key that answered. */
  index: number;
  /** How many earlier keys in this attempt were skipped for quota or rate limit. */
  skipped: number;
}

export async function callWithKeyRotation<T>(options: {
  provider: string;
  keyCount: number;
  startIndex: number;
  call: (index: number) => Promise<T>;
}): Promise<{ value: T; index: number; skipped: number }> {
  const order = rotationOrder(options.keyCount, options.startIndex);
  if (order.length === 0) {
    throw new LlmFailure({
      code: 'QUOTA_EXHAUSTED_ALL_KEYS',
      provider: options.provider,
      message: `all 0 API keys for ${options.provider} are quota-exhausted`,
    });
  }
  let skipped = 0;
  let lastStatus: number | undefined;
  for (const index of order) {
    try {
      const value = await options.call(index);
      return { value, index, skipped };
    } catch (error) {
      if (!isRotatingFailure(error)) throw error;
      lastStatus = error.status;
      skipped += 1;
    }
  }
  throw new LlmFailure({
    code: 'QUOTA_EXHAUSTED_ALL_KEYS',
    provider: options.provider,
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    message: `all ${options.keyCount} API keys for ${options.provider} are quota-exhausted`,
  });
}
