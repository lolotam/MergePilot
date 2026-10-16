import { antigravityUrl, ANTIGRAVITY_HOSTS } from './config.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One Cloud Code Assist call over the fixed host list (ADR-0032 §7). The next host is tried only
 * when this one could not be reached, or answered 404 or 5xx; the caller has not read any of the
 * body yet, so nothing was streamed. 401, 403, 429 and every other answer are returned as they
 * are, and the last host's answer or error is final. An aborted call is never retried.
 */
export async function fetchWithHosts(doFetch: FetchFn, method: string, init: RequestInit): Promise<Response> {
  for (let index = 0; ; index++) {
    const host = ANTIGRAVITY_HOSTS[index]!;
    const last = index === ANTIGRAVITY_HOSTS.length - 1;
    let response: Response;
    try {
      response = await doFetch(antigravityUrl(host, method), init);
    } catch (error) {
      if (last || init.signal?.aborted) throw error;
      continue;
    }
    if (!last && (response.status === 404 || response.status >= 500)) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    return response;
  }
}
