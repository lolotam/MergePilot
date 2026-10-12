import { LlmFailure, type LlmFailureCode } from './failure.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCodes: readonly LlmFailureCode[];
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'NETWORK'] as const,
});

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1); injected so backoff is deterministic in tests. */
  random: () => number;
  signal?: AbortSignal;
}

const defaultDeps: RetryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

function aborted(provider: string): LlmFailure {
  return new LlmFailure({ code: 'ABORTED', provider, message: 'request aborted' });
}

/**
 * Runs `fn` again on retryable `LlmFailure`s with exponential backoff and full jitter.
 * A provider's `retryAfterMs` wins when it is longer. Each retry is another billed request,
 * so anything that is not a retryable `LlmFailure` is rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: RetryDeps = defaultDeps,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof LlmFailure)) throw error;
      if (deps.signal?.aborted) throw aborted(error.provider);
      const retryable = policy.retryableCodes.includes(error.code);
      if (!retryable || attempt >= policy.maxAttempts) throw error;

      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.floor(deps.random() * ceiling);
      await deps.sleep(Math.max(jittered, error.retryAfterMs ?? 0));
      if (deps.signal?.aborted) throw aborted(error.provider);
    }
  }
}
