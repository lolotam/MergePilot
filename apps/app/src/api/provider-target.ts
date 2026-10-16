import { SUBSCRIPTION_PREFIX, type ApiProviderId, type FetchLike } from '@mergepilot/engine';
import { createSafeFetch, DASHBOARD_FETCH_LIMITS } from '../core/safe-fetch.js';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import type { AppStore, KeyProvider } from '../core/types.js';
import { isKeyListProvider } from '../credentials/multi-key.js';
import type { CredentialService } from '../credentials/service.js';

/**
 * Where a provider call from the dashboard goes, and with which key. A preset always uses its
 * fixed registry URL; only `custom` has a URL, which is checked here and again on every call
 * by the guarded fetch (ADR-0010).
 */
export interface ProviderTarget {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
}

export type TargetResult =
  | { ok: true; target: ProviderTarget }
  | { ok: false; status: number; code: string; message: string };

export interface ProviderTargetDeps {
  store: AppStore;
  credentials: CredentialService;
  /** Test seams for the SSRF guard: DNS lookup and the guarded fetch used for `custom`. */
  ssrfLookup?: DnsLookupFn | undefined;
  customFetch?: FetchLike | undefined;
}

const fail = (status: number, code: string, message: string): TargetResult => ({ ok: false, status, code, message });

async function customTarget(
  deps: ProviderTargetDeps,
  apiKey: string,
  baseUrl: string | undefined,
  signal: AbortSignal | undefined,
): Promise<TargetResult> {
  if (!baseUrl?.trim()) return fail(400, 'custom_base_url_required', 'Base URL is required for custom provider');
  let safe: string;
  try {
    safe = await assertSafeBaseUrl(baseUrl, deps.ssrfLookup);
  } catch (err) {
    return fail(400, 'ssrf_validation_error', err instanceof Error ? err.message : 'Base URL is not allowed');
  }
  return {
    ok: true,
    target: {
      apiKey,
      baseUrl: safe,
      fetch: deps.customFetch ?? createSafeFetch({ lookup: deps.ssrfLookup, ...DASHBOARD_FETCH_LIMITS, signal }),
    },
  };
}

/** The workspace's stored key (and, for `custom`, its stored base URL). */
export async function storedTarget(
  deps: ProviderTargetDeps,
  workspaceId: string,
  provider: ApiProviderId,
  signal?: AbortSignal,
): Promise<TargetResult> {
  const cred = await deps.store.getCredential(workspaceId, provider);
  if (!cred) return fail(404, 'key_not_found', `No API key configured for provider "${provider}"`);
  let apiKey: string;
  try {
    const effective = await deps.credentials.getEffectiveAuthMethod(workspaceId, provider as KeyProvider);
    if (effective === 'api-key' && isKeyListProvider(provider)) {
      const roster = await deps.credentials.resolveKeyRoster(workspaceId, provider as KeyProvider);
      const start = roster?.startIndex ?? 0;
      const secret = roster?.secrets[start];
      if (!secret) return fail(404, 'key_not_found', `No API key configured for provider "${provider}"`);
      apiKey = secret.reveal();
    } else {
      apiKey = (await deps.credentials.resolve(workspaceId, provider)).reveal();
    }
  } catch {
    return fail(404, 'key_not_found', `The stored key for "${provider}" could not be read`);
  }
  if (provider === 'custom') return customTarget(deps, apiKey, cred.baseUrl ?? undefined, signal);
  return { ok: true, target: { apiKey } };
}

/** One stored slot, by id. Nothing is written. A missing id is `key_not_found`. */
export async function storedKeyById(
  deps: ProviderTargetDeps,
  workspaceId: string,
  provider: ApiProviderId,
  keyId: string,
  signal?: AbortSignal,
): Promise<TargetResult> {
  let apiKey: string;
  try {
    const secret = await deps.credentials.readStoredKey(workspaceId, provider, keyId);
    if (!secret) return fail(404, 'key_not_found', 'Stored API key was not found');
    apiKey = secret.reveal();
  } catch {
    return fail(404, 'key_not_found', 'The stored key could not be read');
  }
  if (provider === 'custom') {
    const cred = await deps.store.getCredential(workspaceId, provider);
    return customTarget(deps, apiKey, cred?.baseUrl ?? undefined, signal);
  }
  return { ok: true, target: { apiKey } };
}

/** A key typed in the dialog and not saved; a base URL is accepted for `custom` only. */
export async function unsavedTarget(
  deps: ProviderTargetDeps,
  provider: ApiProviderId,
  apiKey: string,
  baseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<TargetResult> {
  const key = apiKey.trim();
  if (!key) return fail(400, 'validation_error', 'apiKey is required');
  if (key.startsWith(SUBSCRIPTION_PREFIX)) return fail(400, 'validation_error', 'Use subscription sign-in instead of the API key field');
  if (provider === 'custom') return customTarget(deps, key, baseUrl, signal);
  if (baseUrl?.trim()) return fail(400, 'base_url_not_allowed', 'Only the custom provider takes a base URL');
  return { ok: true, target: { apiKey: key } };
}

/** The engine options for one call: the custom URL and its guarded fetch, or nothing. */
export function engineOptions(target: ProviderTarget): { baseUrl?: string; fetch?: FetchLike } {
  return {
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.fetch ? { fetch: target.fetch } : {}),
  };
}
