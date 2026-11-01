/**
 * The redirect chain of one request (ADR-0052 section 2).
 *
 * The scanner follows a redirect manually: every hop is a separate request
 * that passes the guards of the package again, so a redirect never inherits
 * the authorization of its source.
 *
 * Two rules bound the chain:
 *
 * - A destination that is not a canonical HTTP URL is never followed. A
 *   `javascript:` location or a malformed one ends the chain instead of
 *   reaching the network.
 * - The chain has a fixed number of hops. The last response stays available
 *   as evidence, but its destination is never requested.
 */

/** The redirect statuses the client follows manually. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The maximum number of redirect hops in one chain. */
export const MAX_REDIRECT_HOPS = 5;

/**
 * The Location header of a redirect response, or null.
 *
 * A response that is not a redirect never has one.
 */
export function redirectLocation(response: { status: number; headers: Headers }): string | null {
  if (!REDIRECT_STATUSES.has(response.status)) {
    return null;
  }
  return response.headers.get('location');
}

/**
 * Resolves a redirect target against the URL it came from.
 *
 * A target that cannot be resolved into a canonical HTTP URL is never
 * followed: it ends the chain instead of reaching the network.
 */
export function resolveHop(
  baseUrl: string,
  location: string,
  isCanonical: (candidate: string) => boolean,
): string | null {
  let resolved: URL;
  try {
    resolved = new URL(location, baseUrl);
  } catch {
    return null;
  }
  if (!isCanonical(resolved.href)) {
    return null;
  }
  return resolved.href;
}
