import { isJudgeKeyOnlyProviderId, resolveBaseUrl, testJudgeConnection, type FetchLike } from '@mergepilot/engine';
import type { KeyProvider } from '../core/types.js';

export class ValidateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidateKeyError';
  }
}

/**
 * A cheap "list models" call that proves a key works before it is saved. For `custom` the
 * caller MUST pass the SSRF-guarded fetch (core/safe-fetch.ts) with the already-checked URL.
 */
export async function validateKey(
  provider: KeyProvider,
  apiKey: string,
  fetchFnOrBaseUrl?: FetchLike | string,
  maybeFetchFn?: FetchLike,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new ValidateKeyError('API key cannot be empty');
  }

  let baseUrl: string | undefined;
  let fetchFn: FetchLike;
  const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

  if (typeof fetchFnOrBaseUrl === 'string') {
    baseUrl = fetchFnOrBaseUrl;
    fetchFn = maybeFetchFn ?? globalFetch;
  } else {
    fetchFn = fetchFnOrBaseUrl ?? globalFetch;
  }

  if (isJudgeKeyOnlyProviderId(provider)) {
    await validateJudgeKey(provider, trimmed, fetchFn);
    return;
  }

  let url: string;
  const headers: Record<string, string> = {};

  switch (provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/models';
      headers['x-api-key'] = trimmed;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'openai':
      url = 'https://api.openai.com/v1/models';
      headers['Authorization'] = `Bearer ${trimmed}`;
      break;
    case 'gemini':
      url = 'https://generativelanguage.googleapis.com/v1beta/models';
      headers['x-goog-api-key'] = trimmed;
      break;
    default: {
      if (provider === 'custom' && !baseUrl) {
        throw new ValidateKeyError('Base URL is required for custom provider');
      }
      const base = resolveBaseUrl(provider, baseUrl);
      url = `${base}/models`;
      headers['Authorization'] = `Bearer ${trimmed}`;
      break;
    }
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
  } catch {
    // Network errors -> "could not verify"; never leak the key
    throw new ValidateKeyError('could not verify');
  }

  if (response.status === 401 || response.status === 403) {
    throw new ValidateKeyError(`invalid key for ${provider}`);
  }

  if (!response.ok) {
    throw new ValidateKeyError('could not verify');
  }
}

/** Judge answers that prove the key authenticated even though the tiny question did not pass. */
const KEY_ACCEPTED_CODES = new Set(['invalid-request', 'model-not-found', 'rate-limited', 'quota']);

/** A Jev-only key (ADR-0015) is proven with one tiny `noul` question: auth failure = invalid key. */
async function validateJudgeKey(provider: 'typesafe' | 'vercel-gateway', apiKey: string, fetchFn: FetchLike): Promise<void> {
  const result = await testJudgeConnection(provider, apiKey, { fetch: fetchFn });
  if (result.ok || KEY_ACCEPTED_CODES.has(result.code)) return;
  if (result.code === 'auth') throw new ValidateKeyError(`invalid key for ${provider}`);
  throw new ValidateKeyError('could not verify');
}
