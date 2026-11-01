import type { CheckSwitches, ScanLimits, ScanScope } from '@mergepilot/webscan';

/**
 * The settings a queued scan runs under (ADR-0052 section 6).
 *
 * A queued scan records the scope, the limits, the checks and the contact it was
 * authorized with. The run uses those settings and not the current global defaults: a
 * scan that runs under settings nobody approved for it is a scan that runs under an
 * authorization that does not exist.
 *
 * The record is read strictly. A record that cannot be read is an error and the scan
 * stops; it never falls back to the current settings of the scanner.
 */

/** The settings of a queued scan. */
export interface WebScanRunSettings {
  scope: ScanScope;
  limits: ScanLimits;
  checks: CheckSwitches;
  contact: string;
}

/** The settings of a queued scan could not be read. */
export class WebScanSettingsError extends Error {
  /** The typed reason the scan was refused with. */
  readonly reason: 'settings_unreadable' | 'contact_unusable';

  constructor(message: string, reason: 'settings_unreadable' | 'contact_unusable' = 'settings_unreadable') {
    super(message);
    this.name = 'WebScanSettingsError';
    this.reason = reason;
  }
}

/**
 * Reads the settings a queued scan was queued with.
 *
 * A record that cannot be read is an error: the scan stops instead of running under
 * the current global defaults.
 */
export function readRunSettings(value: Record<string, unknown>): WebScanRunSettings {
  const scope = readScope(value['scope']);
  const limits = readLimits(value['limits']);
  const checks = readChecks(value['checks']);
  const contact = value['contact'];
  if (typeof contact !== 'string') {
    throw new WebScanSettingsError('The queued scan has no contact.');
  }
  // A contact is empty until an operator sets one. The record is readable, but the
  // scan cannot run without it, so it is refused with its own reason.
  if (contact.trim().length === 0) {
    throw new WebScanSettingsError(
      'The queued scan has no contact.',
      'contact_unusable',
    );
  }
  return { scope, limits, checks, contact };
}

/** Reads the authorized scope of a queued scan. */
function readScope(value: unknown): ScanScope {
  const record = asRecord(value, 'scope');
  return {
    hostname: asString(record['hostname'], 'scope hostname'),
    baseUrl: asString(record['baseUrl'], 'scope base url'),
    crawlPaths: readPathRules(record['crawlPaths'], 'scope crawl paths'),
    blockedPaths: readPathRules(record['blockedPaths'], 'scope blocked paths'),
    parameterizedPaths: readParameterRules(record['parameterizedPaths'], 'scope parameterized paths'),
    activePaths: readParameterRules(record['activePaths'], 'scope active paths'),
    extraFilePaths: readStrings(record['extraFilePaths'], 'scope extra file paths'),
  };
}

/** Reads the limits of a queued scan. */
function readLimits(value: unknown): ScanLimits {
  const record = asRecord(value, 'limits');
  return {
    maxRequests: asPositiveNumber(record['maxRequests'], 'limit max requests'),
    maxPages: asPositiveNumber(record['maxPages'], 'limit max pages'),
    maxActiveLinks: asPositiveNumber(record['maxActiveLinks'], 'limit max active links'),
    requestsPerSecond: asPositiveNumber(record['requestsPerSecond'], 'limit requests per second'),
    requestTimeoutMs: asPositiveNumber(record['requestTimeoutMs'], 'limit request timeout'),
    maxResponseBytes: asPositiveNumber(record['maxResponseBytes'], 'limit max response bytes'),
    totalTimeoutMs: asPositiveNumber(record['totalTimeoutMs'], 'limit total timeout'),
  };
}

/** Reads the check switches of a queued scan. */
function readChecks(value: unknown): CheckSwitches {
  const record = asRecord(value, 'checks');
  const checks: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(record)) {
    if (typeof enabled !== 'boolean') {
      throw new WebScanSettingsError(`The queued scan has an invalid check switch: ${name}.`);
    }
    checks[name] = enabled;
  }
  return checks as CheckSwitches;
}

/** Reads a list of crawl path rules. */
function readPathRules(
  value: unknown,
  label: string,
): ScanScope['crawlPaths'] {
  const items = asArray(value, label);
  return items.map((item) => {
    const record = asRecord(item, label);
    const path = asString(record['path'], `${label} path`);
    const kind = record['kind'];
    if (kind !== 'exact' && kind !== 'prefix') {
      throw new WebScanSettingsError(`The queued scan has an invalid ${label} kind.`);
    }
    return { path, kind };
  });
}

/** Reads a list of parameterized path rules. */
function readParameterRules(
  value: unknown,
  label: string,
): ScanScope['parameterizedPaths'] {
  const items = asArray(value, label);
  return items.map((item) => {
    const record = asRecord(item, label);
    return {
      path: asString(record['path'], `${label} path`),
      parameters: readStrings(record['parameters'], `${label} parameters`),
    };
  });
}

/** Reads a list of strings. */
function readStrings(value: unknown, label: string): string[] {
  const items = asArray(value, label);
  return items.map((item) => asString(item, label));
}

/** Reads a record of an unknown value. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebScanSettingsError(`The queued scan has no valid ${label}.`);
  }
  return value as Record<string, unknown>;
}

/** Reads an array of an unknown value. */
function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WebScanSettingsError(`The queued scan has no valid ${label}.`);
  }
  return value;
}

/** Reads a string of an unknown value. */
function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebScanSettingsError(`The queued scan has no valid ${label}.`);
  }
  return value;
}

/** Reads a positive number of an unknown value. */
function asPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new WebScanSettingsError(`The queued scan has no valid ${label}.`);
  }
  return value;
}
