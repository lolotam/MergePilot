import type { ApiProviderId, FetchLike } from '@mergepilot/engine';
import { createSafeFetch } from '../core/safe-fetch.js';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import type { AppStore } from '../core/types.js';
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

async function customTarget(deps: ProviderTargetDeps, apiKey: string, baseUrl: string | undefined): Promise<TargetResult> {
  if (!baseUrl?.trim()) return fail(400, 'custom_base_url_required', 'Base URL is required for custom provider');
  let safe: string;
  try {
    safe = await assertSafeBaseUrl(baseUrl, deps.ssrfLookup);
  } catch (err) {
    return fail(400, 'ssrf_validation_error', err instanceof Error ? err.message : 'Base URL is not allowed');
  }
  return {
    ok: true,
    target: { apiKey, baseUrl: safe, fetch: deps.customFetch ?? createSafeFetch({ lookup: deps.ssrfLookup }) },
  };
}

/** The workspace's stored key (and, for `custom`, its stored base URL). */
export async function storedTarget(
  deps: ProviderTargetDeps,
  workspaceId: string,
  provider: ApiProviderId,
): Promise<TargetResult> {
  const cred = await deps.store.getCredential(workspaceId, provider);
  if (!cred) return fail(404, 'key_not_found', `No API key configured for provider "${provider}"`);
  let apiKey: string;
  try {
    apiKey = (await deps.credentials.resolve(workspaceId, provider)).reveal();
  } catch {
    return fail(404, 'key_not_found', `The stored key for "${provider}" could not be read`);
  }
  if (provider === 'custom') return customTarget(deps, apiKey, cred.baseUrl ?? undefined);
  return { ok: true, target: { apiKey } };
}

/** A key typed in the dialog and not saved; a base URL is accepted for `custom` only. */
export async function unsavedTarget(
  deps: ProviderTargetDeps,
  provider: ApiProviderId,
  apiKey: string,
  baseUrl: string | undefined,
): Promise<TargetResult> {
  const key = apiKey.trim();
  if (!key) return fail(400, 'validation_error', 'apiKey is required');
  if (provider === 'custom') return customTarget(deps, key, baseUrl);
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
