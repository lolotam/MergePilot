import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCAN_LIMITS,
  SCAN_LIMIT_FIELDS,
  SCAN_LIMIT_SPECS,
  ScanSettingsError,
  assertAboveDefaultConfirmation,
  clampScanLimitsForWorker,
  effectiveScanLimits,
  limitsConfirmationDigest,
  parseScanLimitOverrides,
  parseScanLimits,
  requiresAboveDefaultConfirmation,
  resolveScanLimits,
  validateScanLimits,
  type ScanSettingsErrorCode,
} from './settings.js';
import type { ScanLimits } from './types.js';

function expectRejected(code: ScanSettingsErrorCode, run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ScanSettingsError);
  expect((thrown as ScanSettingsError).code).toBe(code);
}

const VALID_LIMITS: ScanLimits = {
  maxRequests: 500,
  maxPages: 100,
  maxActiveLinks: 30,
  requestsPerSecond: 2,
  requestTimeoutMs: 10000,
  maxResponseBytes: 1048576,
  totalTimeoutMs: 1200000,
};

describe('the limit table', () => {
  it('matches the documented minimum, default and ceiling of every field', () => {
    expect(SCAN_LIMIT_SPECS).toEqual({
      maxRequests: { min: 1, default: 500, max: 2000 },
      maxPages: { min: 1, default: 100, max: 300 },
      maxActiveLinks: { min: 1, default: 30, max: 100 },
      requestsPerSecond: { min: 1, default: 2, max: 5 },
      requestTimeoutMs: { min: 1000, default: 10000, max: 30000 },
      maxResponseBytes: { min: 1024, default: 1048576, max: 5242880 },
      totalTimeoutMs: { min: 60000, default: 1200000, max: 3600000 },
    });
  });

  it('is frozen so no request can widen it at runtime', () => {
    expect(Object.isFrozen(SCAN_LIMIT_SPECS)).toBe(true);
    expect(Object.isFrozen(SCAN_LIMIT_SPECS.maxRequests)).toBe(true);
  });

  it('exposes the defaults as a complete limits object', () => {
    expect(DEFAULT_SCAN_LIMITS).toEqual(VALID_LIMITS);
  });
});

describe('parseScanLimits', () => {
  it('accepts a complete valid object', () => {
    expect(parseScanLimits(VALID_LIMITS)).toEqual(VALID_LIMITS);
  });

  it('accepts the documented minimum and ceiling of every field', () => {
    const atBounds: ScanLimits = {
      maxRequests: 1,
      maxPages: 1,
      maxActiveLinks: 1,
      requestsPerSecond: 1,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      totalTimeoutMs: 60000,
    };
    const atCeilings: ScanLimits = {
      maxRequests: 2000,
      maxPages: 300,
      maxActiveLinks: 100,
      requestsPerSecond: 5,
      requestTimeoutMs: 30000,
      maxResponseBytes: 5242880,
      totalTimeoutMs: 3600000,
    };

    expect(parseScanLimits(atBounds)).toEqual(atBounds);
    expect(parseScanLimits(atCeilings)).toEqual(atCeilings);
  });

  it('rejects an unknown field instead of silently keeping a default', () => {
    expectRejected('unknown_field', () => parseScanLimits({ ...VALID_LIMITS, maxErrors: 5 }));
  });

  it('rejects a missing field', () => {
    const { maxPages: _maxPages, ...incomplete } = VALID_LIMITS;
    expectRejected('missing_field', () => parseScanLimits(incomplete));
  });

  it('rejects a value that is not a number', () => {
    expectRejected('not_a_number', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: '500' }));
  });

  it('rejects a non-finite value', () => {
    expectRejected('not_finite', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: Number.NaN }));
    expectRejected('not_finite', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: Number.POSITIVE_INFINITY }));
  });

  it('rejects a fractional value', () => {
    expectRejected('not_integer', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: 500.5 }));
  });

  it('rejects a non-positive value', () => {
    expectRejected('not_positive', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: 0 }));
    expectRejected('not_positive', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: -1 }));
  });

  it('rejects a value below its minimum and above its ceiling', () => {
    expectRejected('below_minimum', () => parseScanLimits({ ...VALID_LIMITS, requestTimeoutMs: 999 }));
    expectRejected('above_maximum', () => parseScanLimits({ ...VALID_LIMITS, maxRequests: 2001 }));
  });
});

describe('parseScanLimitOverrides', () => {
  it('accepts a partial object and leaves the rest to the global defaults', () => {
    expect(parseScanLimitOverrides({ maxPages: 50 })).toEqual({ maxPages: 50 });
  });

  it('accepts an empty object', () => {
    expect(parseScanLimitOverrides({})).toEqual({});
  });

  it('rejects an unknown field', () => {
    expectRejected('unknown_field', () => parseScanLimitOverrides({ maxPage: 50 }));
  });

  it('rejects an out-of-range value', () => {
    expectRejected('above_maximum', () => parseScanLimitOverrides({ maxPages: 301 }));
  });
});

describe('resolveScanLimits', () => {
  it('lets a per-site override win over the global default', () => {
    const resolved = resolveScanLimits(VALID_LIMITS, { maxRequests: 250 });

    expect(resolved.maxRequests).toBe(250);
  });

  it('keeps the global value for every field the site does not override', () => {
    const resolved = resolveScanLimits(VALID_LIMITS, { maxRequests: 250, maxPages: 10 });

    expect(resolved).toEqual({ ...VALID_LIMITS, maxRequests: 250, maxPages: 10 });
  });

  it('resolves to the global defaults without overrides', () => {
    expect(resolveScanLimits(VALID_LIMITS)).toEqual(VALID_LIMITS);
  });
});

describe('clampScanLimitsForWorker', () => {
  it('clamps a value above its ceiling back to the ceiling', () => {
    const clamped = clampScanLimitsForWorker({ ...VALID_LIMITS, maxRequests: 5000, maxPages: 900 });

    expect(clamped.maxRequests).toBe(2000);
    expect(clamped.maxPages).toBe(300);
  });

  it('keeps a value inside the bounds unchanged', () => {
    expect(clampScanLimitsForWorker(VALID_LIMITS)).toEqual(VALID_LIMITS);
  });

  it('rejects an invalid or non-positive value', () => {
    expectRejected('not_finite', () => clampScanLimitsForWorker({ ...VALID_LIMITS, maxRequests: Number.NaN }));
    expectRejected('not_integer', () => clampScanLimitsForWorker({ ...VALID_LIMITS, maxRequests: 10.5 }));
    expectRejected('not_positive', () => clampScanLimitsForWorker({ ...VALID_LIMITS, maxRequests: 0 }));
  });

  it('rejects a value below its minimum instead of widening the scan budget', () => {
    expectRejected('below_minimum', () => clampScanLimitsForWorker({ ...VALID_LIMITS, requestTimeoutMs: 500 }));
  });
});

describe('effectiveScanLimits', () => {
  it('resolves the site override over the global default before it validates', () => {
    const effective = effectiveScanLimits(VALID_LIMITS, { maxRequests: 250, maxPages: 50 });

    expect(effective.maxRequests).toBe(250);
    expect(effective.maxPages).toBe(50);
    expect(effective.maxActiveLinks).toBe(VALID_LIMITS.maxActiveLinks);
  });

  it('keeps every effective value inside its documented ceiling', () => {
    const effective = effectiveScanLimits(VALID_LIMITS, { maxRequests: 250 });

    for (const field of SCAN_LIMIT_FIELDS) {
      expect(effective[field]).toBeLessThanOrEqual(SCAN_LIMIT_SPECS[field].max);
    }
  });

  it('rejects an override outside the documented bounds before any clamping happens', () => {
    expectRejected('above_maximum', () => effectiveScanLimits(VALID_LIMITS, { maxRequests: 5000 }));
  });
});

describe('the above-default confirmation', () => {
  it('is not required at or below the defaults', () => {
    expect(requiresAboveDefaultConfirmation(VALID_LIMITS)).toBe(false);
    expect(requiresAboveDefaultConfirmation({ ...VALID_LIMITS, maxRequests: 100 })).toBe(false);
  });

  it('is required as soon as one value is above its default', () => {
    expect(requiresAboveDefaultConfirmation({ ...VALID_LIMITS, maxRequests: 501 })).toBe(true);
  });

  it('accepts a confirmation that carries the digest of the submitted values', () => {
    const limits = { ...VALID_LIMITS, maxRequests: 600 };

    expect(() =>
      assertAboveDefaultConfirmation(limits, { digest: limitsConfirmationDigest(limits) }),
    ).not.toThrow();
  });

  it('rejects a missing confirmation for an above-default value', () => {
    expectRejected('above_default_confirmation_required', () =>
      assertAboveDefaultConfirmation({ ...VALID_LIMITS, maxRequests: 600 }),
    );
  });

  it('rejects a confirmation given for different values', () => {
    const confirmed = { ...VALID_LIMITS, maxRequests: 600 };
    const submitted = { ...VALID_LIMITS, maxRequests: 900 };

    expectRejected('above_default_confirmation_required', () =>
      assertAboveDefaultConfirmation(submitted, { digest: limitsConfirmationDigest(confirmed) }),
    );
  });

  it('binds the confirmation to the effective values after a site override is resolved', () => {
    const globalDefaults = { ...VALID_LIMITS, maxRequests: 400 };
    const overrides = { maxRequests: 600 };
    const effective = resolveScanLimits(globalDefaults, overrides);

    expect(requiresAboveDefaultConfirmation(effective)).toBe(true);
    expect(() =>
      assertAboveDefaultConfirmation(effective, { digest: limitsConfirmationDigest(effective) }),
    ).not.toThrow();
    expectRejected('above_default_confirmation_required', () =>
      assertAboveDefaultConfirmation(effective, { digest: limitsConfirmationDigest(globalDefaults) }),
    );
  });

  it('does not require a confirmation when no value is above its default', () => {
    expect(() => assertAboveDefaultConfirmation(VALID_LIMITS)).not.toThrow();
  });
});

describe('validateScanLimits', () => {
  it('returns the validated limits unchanged', () => {
    expect(validateScanLimits(VALID_LIMITS)).toEqual(VALID_LIMITS);
  });

  it('rejects an invalid effective value', () => {
    expectRejected('above_maximum', () => validateScanLimits({ ...VALID_LIMITS, maxPages: 301 }));
  });
});
