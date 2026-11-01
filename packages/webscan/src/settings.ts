/**
 * Numeric policy for scan limits (ADR-0052 section 5).
 *
 * Every limit is a finite positive integer in its stored unit. The API rejects
 * values outside the documented bounds. The worker rejects invalid or
 * non-positive values and clamps positive values back to the ceiling before a
 * scan starts. A value above its default needs a second confirmation that is
 * bound to the effective submitted values.
 *
 * This module is pure: it never touches storage, the network or the clock.
 */

import { createHash } from 'node:crypto';

import type { ScanLimits } from './types.js';

/** The documented bounds of one stored limit field. */
export interface ScanLimitSpec {
  /** Smallest accepted value. */
  readonly min: number;
  /** Default value, also the threshold above which a confirmation is needed. */
  readonly default: number;
  /** Hard ceiling enforced in code, independent of any setting. */
  readonly max: number;
}

/**
 * The immutable limit table, in stored units.
 *
 * The order of `SCAN_LIMIT_FIELDS` is the canonical order used by every
 * digest, so the same effective values always produce the same digest.
 */
export const SCAN_LIMIT_SPECS = Object.freeze({
  maxRequests: Object.freeze({ min: 1, default: 500, max: 2000 }),
  maxPages: Object.freeze({ min: 1, default: 100, max: 300 }),
  maxActiveLinks: Object.freeze({ min: 1, default: 30, max: 100 }),
  requestsPerSecond: Object.freeze({ min: 1, default: 2, max: 5 }),
  requestTimeoutMs: Object.freeze({ min: 1000, default: 10000, max: 30000 }),
  maxResponseBytes: Object.freeze({ min: 1024, default: 1048576, max: 5242880 }),
  totalTimeoutMs: Object.freeze({ min: 60000, default: 1200000, max: 3600000 }),
}) satisfies Readonly<Record<keyof ScanLimits, ScanLimitSpec>>;

/** Every limit field, in canonical order. */
export const SCAN_LIMIT_FIELDS = Object.freeze([
  'maxRequests',
  'maxPages',
  'maxActiveLinks',
  'requestsPerSecond',
  'requestTimeoutMs',
  'maxResponseBytes',
  'totalTimeoutMs',
] as const satisfies readonly (keyof ScanLimits)[]);

/** The default limits, taken from the immutable table. */
export const DEFAULT_SCAN_LIMITS: ScanLimits = Object.freeze({
  maxRequests: SCAN_LIMIT_SPECS.maxRequests.default,
  maxPages: SCAN_LIMIT_SPECS.maxPages.default,
  maxActiveLinks: SCAN_LIMIT_SPECS.maxActiveLinks.default,
  requestsPerSecond: SCAN_LIMIT_SPECS.requestsPerSecond.default,
  requestTimeoutMs: SCAN_LIMIT_SPECS.requestTimeoutMs.default,
  maxResponseBytes: SCAN_LIMIT_SPECS.maxResponseBytes.default,
  totalTimeoutMs: SCAN_LIMIT_SPECS.totalTimeoutMs.default,
});

/** Why a limit value was rejected. */
export type ScanSettingsErrorCode =
  | 'unknown_field'
  | 'missing_field'
  | 'not_a_number'
  | 'not_finite'
  | 'not_integer'
  | 'not_positive'
  | 'below_minimum'
  | 'above_maximum'
  | 'above_default_confirmation_required';

/** A rejected limit value. The rejected value itself is never carried. */
export class ScanSettingsError extends Error {
  readonly code: ScanSettingsErrorCode;
  readonly field: string | undefined;

  constructor(code: ScanSettingsErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ScanSettingsError';
    this.code = code;
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one stored limit value against its documented bounds.
 *
 * Non-finite, fractional, non-positive and out-of-range values are rejected.
 */
export function validateScanLimitValue(field: keyof ScanLimits, value: unknown): number {
  const spec = SCAN_LIMIT_SPECS[field];
  if (typeof value !== 'number') {
    throw new ScanSettingsError('not_a_number', `${field} must be a number.`, field);
  }
  if (!Number.isFinite(value)) {
    throw new ScanSettingsError('not_finite', `${field} must be a finite number.`, field);
  }
  if (!Number.isInteger(value)) {
    throw new ScanSettingsError('not_integer', `${field} must be a whole number.`, field);
  }
  if (value <= 0) {
    throw new ScanSettingsError('not_positive', `${field} must be greater than zero.`, field);
  }
  if (value < spec.min) {
    throw new ScanSettingsError('below_minimum', `${field} is below its minimum.`, field);
  }
  if (value > spec.max) {
    throw new ScanSettingsError('above_maximum', `${field} is above its ceiling.`, field);
  }
  return value;
}

/**
 * Validates a complete limits object, as stored in the global settings row.
 *
 * Unknown and missing fields are rejected so a typo never silently keeps a
 * default value.
 */
export function parseScanLimits(value: unknown): ScanLimits {
  if (!isPlainObject(value)) {
    throw new ScanSettingsError('not_a_number', 'Scan limits must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!SCAN_LIMIT_FIELDS.includes(key as keyof ScanLimits)) {
      throw new ScanSettingsError('unknown_field', `Unknown scan limit: ${key}.`, key);
    }
  }
  const limits = {} as ScanLimits;
  for (const field of SCAN_LIMIT_FIELDS) {
    if (!(field in value)) {
      throw new ScanSettingsError('missing_field', `Missing scan limit: ${field}.`, field);
    }
    limits[field] = validateScanLimitValue(field, value[field]);
  }
  return limits;
}

/**
 * Validates a partial limits object, as stored in a per-site override row.
 *
 * Only the fields the site overrides are present; the rest come from the
 * global defaults.
 */
export function parseScanLimitOverrides(value: unknown): Partial<ScanLimits> {
  if (!isPlainObject(value)) {
    throw new ScanSettingsError('not_a_number', 'Scan limit overrides must be an object.');
  }
  const overrides: Partial<ScanLimits> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SCAN_LIMIT_FIELDS.includes(key as keyof ScanLimits)) {
      throw new ScanSettingsError('unknown_field', `Unknown scan limit: ${key}.`, key);
    }
    const field = key as keyof ScanLimits;
    overrides[field] = validateScanLimitValue(field, raw);
  }
  return overrides;
}

/**
 * Resolves the effective limits of one site: a per-site override wins over the
 * global default, and every field the site does not override keeps the global
 * value. Resolution performs no validation and no clamping.
 */
export function resolveScanLimits(
  globalDefaults: ScanLimits,
  overrides?: Partial<ScanLimits>,
): ScanLimits {
  const pick = (field: keyof ScanLimits): number => {
    const override = overrides?.[field];
    return override === undefined ? globalDefaults[field] : override;
  };
  return {
    maxRequests: pick('maxRequests'),
    maxPages: pick('maxPages'),
    maxActiveLinks: pick('maxActiveLinks'),
    requestsPerSecond: pick('requestsPerSecond'),
    requestTimeoutMs: pick('requestTimeoutMs'),
    maxResponseBytes: pick('maxResponseBytes'),
    totalTimeoutMs: pick('totalTimeoutMs'),
  };
}

/**
 * Re-validates an effective limits object. Used after resolution so an
 * invalid stored value is caught before anything else happens.
 */
export function validateScanLimits(limits: ScanLimits): ScanLimits {
  return parseScanLimits(limits);
}

/**
 * The worker's last guard before a scan starts.
 *
 * Invalid, non-finite, fractional and non-positive values are rejected. A
 * positive value above its ceiling is clamped back to the ceiling. A positive
 * value below its minimum is rejected rather than raised: clamping upwards
 * would widen the scan budget beyond what was authorized.
 */
export function clampScanLimitsForWorker(limits: ScanLimits): ScanLimits {
  const clamp = (field: keyof ScanLimits): number => {
    const spec = SCAN_LIMIT_SPECS[field];
    const value = limits[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ScanSettingsError('not_finite', `${field} must be a finite number.`, field);
    }
    if (!Number.isInteger(value)) {
      throw new ScanSettingsError('not_integer', `${field} must be a whole number.`, field);
    }
    if (value <= 0) {
      throw new ScanSettingsError('not_positive', `${field} must be greater than zero.`, field);
    }
    if (value < spec.min) {
      throw new ScanSettingsError('below_minimum', `${field} is below its minimum.`, field);
    }
    return value > spec.max ? spec.max : value;
  };
  return {
    maxRequests: clamp('maxRequests'),
    maxPages: clamp('maxPages'),
    maxActiveLinks: clamp('maxActiveLinks'),
    requestsPerSecond: clamp('requestsPerSecond'),
    requestTimeoutMs: clamp('requestTimeoutMs'),
    maxResponseBytes: clamp('maxResponseBytes'),
    totalTimeoutMs: clamp('totalTimeoutMs'),
  };
}

/**
 * Resolves, validates and clamps in the only safe order.
 *
 * The site overrides are resolved over the global defaults, the effective
 * values are validated against the documented bounds, and only then is the
 * worker ceiling applied. The order matters twice: an out-of-range value is
 * rejected instead of being silently narrowed, so the confirmation the
 * administrator gave still describes the values that will run; and the
 * ceiling is only ever reached by a narrowing clamp.
 */
export function effectiveScanLimits(
  globalDefaults: ScanLimits,
  overrides?: Partial<ScanLimits>,
): ScanLimits {
  return clampScanLimitsForWorker(validateScanLimits(resolveScanLimits(globalDefaults, overrides)));
}

/** The confirmation of an above-default limit set, bound to its values. */
export interface AboveDefaultConfirmation {
  /** The digest of the effective submitted values the administrator confirmed. */
  readonly digest: string;
}

/**
 * The digest of an effective limits object.
 *
 * The digest covers every effective value, so a confirmation given for one set
 * of values never validates a different set.
 */
export function limitsConfirmationDigest(limits: ScanLimits): string {
  const canonical = SCAN_LIMIT_FIELDS.map((field) => `${field}=${limits[field]}`).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The fields of an effective limits object that are above their default. */
export function limitsAboveDefault(limits: ScanLimits): readonly (keyof ScanLimits)[] {
  return SCAN_LIMIT_FIELDS.filter((field) => limits[field] > SCAN_LIMIT_SPECS[field].default);
}

/**
 * Whether an effective limits object needs a second confirmation. Only a
 * value above its default does.
 */
export function requiresAboveDefaultConfirmation(limits: ScanLimits): boolean {
  return limitsAboveDefault(limits).length > 0;
}

/**
 * Checks the confirmation of an effective limits object.
 *
 * The confirmation is bound to the submitted effective values: it must carry
 * the digest of exactly these values. Callers pass the resolved limits, never
 * the raw request body, so a per-site override is covered by the same digest.
 */
export function assertAboveDefaultConfirmation(
  limits: ScanLimits,
  confirmation?: AboveDefaultConfirmation,
): void {
  if (!requiresAboveDefaultConfirmation(limits)) {
    return;
  }
  if (confirmation === undefined || confirmation.digest !== limitsConfirmationDigest(limits)) {
    throw new ScanSettingsError(
      'above_default_confirmation_required',
      'A value above its default needs a confirmation bound to the submitted values.',
    );
  }
}
