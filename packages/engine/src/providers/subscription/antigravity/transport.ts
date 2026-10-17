import { antigravityUrl, ANTIGRAVITY_HOSTS } from './config.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Releases a body that will not be read. The status already decided the outcome, so a failing cancel changes nothing. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is already gone.
  }
}

/** A 2xx answer whose body is not JSON. Fixed message, no cause: a parse error can quote the body. */
export class MalformedResponseError extends Error {
  constructor(what: string) {
    super(`${what} answered with a body that is not JSON`);
    this.name = 'MalformedResponseError';
  }
}

export async function readJson(response: Response, what: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MalformedResponseError(what);
  }
}

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
      await discardBody(response);
      continue;
    }
    return response;
  }
}
