import type { WebScanLimits, WebScanLimitsPatch } from '@mergepilot/app/contract';

/**
 * The documented bounds of every scan limit (ADR-0052 section 5).
 *
 * The table lives in `packages/webscan` next to the worker that enforces it,
 * but that module reaches for `node:crypto`, so the browser bundle cannot
 * import it. The dashboard keeps its own copy of the same documented numbers:
 * they are the ADR's table, and the server stays the authority that refuses a
 * value outside them.
 */
export interface WebScanLimitSpec {
  /** Smallest accepted value. */
  readonly min: number;
  /** Default value, and the threshold above which a confirmation is needed. */
  readonly default: number;
  /** Hard ceiling enforced in code. */
  readonly max: number;
}

export const WEB_SCAN_LIMIT_SPECS: Readonly<Record<keyof WebScanLimits, WebScanLimitSpec>> = {
  maxRequests: { min: 1, default: 500, max: 2000 },
  maxPages: { min: 1, default: 100, max: 300 },
  maxActiveLinks: { min: 1, default: 30, max: 100 },
  requestsPerSecond: { min: 1, default: 2, max: 5 },
  requestTimeoutMs: { min: 1000, default: 10000, max: 30000 },
  maxResponseBytes: { min: 1024, default: 1048576, max: 5242880 },
  totalTimeoutMs: { min: 60000, default: 1200000, max: 3600000 },
};

/** Every limit field, in the canonical order the digest is built in. */
export const WEB_SCAN_LIMIT_FIELDS = [
  'maxRequests',
  'maxPages',
  'maxActiveLinks',
  'requestsPerSecond',
  'requestTimeoutMs',
  'maxResponseBytes',
  'totalTimeoutMs',
] as const satisfies readonly (keyof WebScanLimits)[];

/** The limit fields whose effective value is above its default. */
export function limitsAboveDefault(limits: WebScanLimits): (keyof WebScanLimits)[] {
  return WEB_SCAN_LIMIT_FIELDS.filter((field) => limits[field] > WEB_SCAN_LIMIT_SPECS[field].default);
}

/**
 * The effective limits of a patch: the stored limits with the submitted fields
 * on top. It is the same resolution the server does before it checks the
 * confirmation, so the digest covers the same values.
 */
export function effectiveLimits(base: WebScanLimits, patch: WebScanLimitsPatch | undefined): WebScanLimits {
  return {
    maxRequests: patch?.maxRequests ?? base.maxRequests,
    maxPages: patch?.maxPages ?? base.maxPages,
    maxActiveLinks: patch?.maxActiveLinks ?? base.maxActiveLinks,
    requestsPerSecond: patch?.requestsPerSecond ?? base.requestsPerSecond,
    requestTimeoutMs: patch?.requestTimeoutMs ?? base.requestTimeoutMs,
    maxResponseBytes: patch?.maxResponseBytes ?? base.maxResponseBytes,
    totalTimeoutMs: patch?.totalTimeoutMs ?? base.totalTimeoutMs,
  };
}

/**
 * The digest that confirms a set of effective limits (ADR-0052 section 5).
 *
 * The server binds the confirmation to the submitted values, so the dashboard
 * builds the same digest: the SHA-256 of the canonical `field=value` lines, in
 * the canonical field order. The browser's Web Crypto owns the hash, so no
 * crypto library is needed on the client.
 */
export async function limitsConfirmationDigest(limits: WebScanLimits): Promise<string> {
  const canonical = WEB_SCAN_LIMIT_FIELDS.map((field) => `${field}=${limits[field]}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
