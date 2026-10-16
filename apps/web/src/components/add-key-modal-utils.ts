import type { TestConnectionResponse } from '../api/client.js';

export interface KeyField {
  id: string;
  value: string;
  testing: boolean;
  result: TestConnectionResponse | null;
  /** Monotonic token for the in-flight test; stale responses are ignored. */
  testToken: number;
  /** Value sent with the active test request. */
  testedValue: string;
}

/** `unverified`: a transient failure (rate limit, outage, network) says nothing about the key. */
export function quotaOutcome(result: TestConnectionResponse): 'valid' | 'invalid' | 'quota-exhausted' | 'unverified' {
  if (result.quotaStatus) return result.quotaStatus;
  if (result.ok) return 'valid';
  if (result.code === 'quota') return 'quota-exhausted';
  return result.code === 'auth' ? 'invalid' : 'unverified';
}

export function outcomeColor(status: ReturnType<typeof quotaOutcome>): string {
  if (status === 'valid') return 'text-emerald-700 dark:text-emerald-300';
  if (status === 'unverified') return 'text-amber-700 dark:text-amber-300';
  return 'text-red-600 dark:text-red-300';
}

export function blankField(id: string): KeyField {
  return { id, value: '', testing: false, result: null, testToken: 0, testedValue: '' };
}
