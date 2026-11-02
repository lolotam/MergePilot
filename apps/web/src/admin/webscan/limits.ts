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

/**
 * The limit fields whose effective value is above its default.
 *
 * The dashboard marks such a value before it is saved; the confirmation of the
 * change is the server's, and it names the fields itself.
 */
export function limitsAboveDefault(limits: WebScanLimits): (keyof WebScanLimits)[] {
  return (Object.keys(WEB_SCAN_LIMIT_SPECS) as (keyof WebScanLimits)[]).filter(
    (field) => limits[field] > WEB_SCAN_LIMIT_SPECS[field].default,
  );
}

/**
 * The effective limits of a patch: the stored limits with the submitted fields
 * on top. It is the same resolution the server does before it checks the
 * confirmation, so the values the administrator sees are the values the server
 * is about to store.
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
