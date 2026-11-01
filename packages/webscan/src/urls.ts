/**
 * Canonical URLs of the scanner (ADR-0052 section 2).
 *
 * Every decision of the scope is taken against a canonical URL, so the
 * canonical form has to be exact:
 *
 * - The scheme is `http:` or `https:`, the port is the default one of the
 *   scheme and the URL never carries credentials.
 * - The hostname is lowercase and punycode, without a trailing dot: a
 *   trailing dot names the same host, so it must not create a second identity
 *   for one site.
 * - The path is decoded before it is split into segments, because a server
 *   decodes an encoded separator before it routes the request. Dot segments
 *   are resolved, so a link cannot use an encoded traversal to reach a path
 *   its rules would never authorize.
 * - The fragment is removed: it is never sent to the server.
 */

/** Why a URL was rejected before any request was sent. */
export type ScanUrlErrorCode =
  | 'invalid_url'
  | 'malformed_encoding'
  | 'credentials_present'
  | 'unsupported_scheme'
  | 'non_default_port';

/** A URL that cannot be canonicalized. */
export class ScanUrlError extends Error {
  readonly code: ScanUrlErrorCode;

  constructor(code: ScanUrlErrorCode, message: string) {
    super(message);
    this.name = 'ScanUrlError';
    this.code = code;
  }
}

/** One decoded query parameter. */
export interface QueryPair {
  readonly name: string;
  readonly value: string;
}

/** A canonical URL, safe to compare against scope rules. */
export interface CanonicalUrl {
  /** The scheme, always `http:` or `https:`. */
  readonly protocol: 'http:' | 'https:';
  /** Canonical hostname: lowercase, punycode, without a trailing dot. */
  readonly hostname: string;
  /** Canonical host for display; the scheme's default port is omitted. */
  readonly host: string;
  /** Canonical path, percent-encoding preserved. */
  readonly path: string;
  /** Decoded path segments, without the empty leading segment. */
  readonly segments: readonly string[];
  /** Raw query string, without the leading `?`. */
  readonly query: string;
  /** Decoded query parameters, in document order. */
  readonly queryPairs: readonly QueryPair[];
  /** Decoded query parameter names, in document order. */
  readonly queryNames: readonly string[];
}

const DEFAULT_PORTS: Readonly<Record<'http:' | 'https:', string>> = Object.freeze({
  'http:': '80',
  'https:': '443',
});

const HEX_ESCAPE = /^[0-9A-Fa-f]{2}$/;

/**
 * Canonicalizes a hostname: lowercase, punycode, without a trailing dot.
 *
 * A trailing dot names the same host in DNS, so it must not create a second
 * identity for one site.
 */
export function canonicalHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  const withoutTrailingDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (withoutTrailingDot === '') {
    return '';
  }
  try {
    return new URL(`https://${withoutTrailingDot}`).hostname.toLowerCase();
  } catch {
    return withoutTrailingDot;
  }
}

/** Canonicalizes an administrator-supplied path rule. */
export function normalizeRulePath(path: string): string {
  try {
    return new URL(path, 'https://scope.invalid/').pathname;
  } catch {
    return path.startsWith('/') ? path : `/${path}`;
  }
}

/**
 * Compares two strings by their UTF-16 code units.
 *
 * The comparison is case sensitive and independent of the locale, so the order
 * of a canonical list never depends on the machine that sorted it.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertWellFormedEncoding(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') {
      continue;
    }
    if (!HEX_ESCAPE.test(value.slice(index + 1, index + 3))) {
      throw new ScanUrlError('malformed_encoding', 'The URL contains a malformed percent escape.');
    }
    index += 2;
  }
}

/**
 * The decoded path segments of a canonical path.
 *
 * A segment is decoded before it is split, because a server decodes an
 * encoded separator before it routes the request: `/a%2Fb` is two segments
 * for the server, not one. Dot segments are then resolved, so a link cannot
 * use an encoded traversal to reach a path its rules would never authorize.
 */
export function decodeSegments(path: string): string[] {
  const body = path.startsWith('/') ? path.slice(1) : path;
  if (body === '') {
    return [];
  }
  const resolved: string[] = [];
  for (const raw of body.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new ScanUrlError('malformed_encoding', 'The URL contains a malformed percent escape.');
    }
    for (const part of decoded.split('/')) {
      if (part === '.') {
        continue;
      }
      if (part === '..') {
        resolved.pop();
        continue;
      }
      resolved.push(part);
    }
  }
  return resolved;
}

function readQueryPairs(query: string): QueryPair[] {
  const pairs: QueryPair[] = [];
  for (const [name, value] of new URLSearchParams(query)) {
    pairs.push({ name, value });
  }
  return pairs;
}

/**
 * Parses and canonicalizes an absolute URL.
 *
 * Rejects malformed percent encoding, credentials, non-HTTP schemes and any
 * port other than the scheme's default. Fragments are removed, because a
 * fragment is never sent to the server.
 */
export function parseCanonicalUrl(raw: string): CanonicalUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ScanUrlError('invalid_url', 'The URL could not be parsed.');
  }
  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new ScanUrlError('unsupported_scheme', 'Only http and https URLs are supported.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ScanUrlError('credentials_present', 'URLs with credentials are rejected.');
  }
  if (parsed.port !== '' && parsed.port !== DEFAULT_PORTS[protocol]) {
    throw new ScanUrlError('non_default_port', 'Only default HTTP and HTTPS ports are allowed.');
  }
  const hostname = canonicalHostname(parsed.hostname);
  if (hostname === '') {
    throw new ScanUrlError('invalid_url', 'The URL has no host.');
  }
  assertWellFormedEncoding(parsed.pathname);
  assertWellFormedEncoding(parsed.search);
  const segments = decodeSegments(parsed.pathname);
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
  const queryPairs = readQueryPairs(query);
  return {
    protocol,
    hostname,
    host: hostname,
    path: parsed.pathname,
    segments,
    query,
    queryPairs,
    queryNames: queryPairs.map((pair) => pair.name),
  };
}
