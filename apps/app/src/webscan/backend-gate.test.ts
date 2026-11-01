import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CheckSwitches, ScanScope } from '@mergepilot/webscan';
import { requestFingerprint, type ManualScanRequest } from './pg-scans.js';
import { nextScheduledRun, parseSchedule } from './schedule.js';
import type { WebScanSchedule } from './types.js';

/**
 * The backend gate of the website security scanner (ADR-0052).
 *
 * These checks need no service, so they run in the ordinary unit gate. They cover the
 * three properties that the wiring itself depends on and that no later test can
 * repair silently:
 *
 *  - the package boundary of ADR-0001: `packages/webscan` stays dependency-injected
 *    and imports nothing from `apps/` or from the review engine;
 *  - the schedule arithmetic of ADR-0052 section 5 and section 7: a slot is a Kuwait
 *    wall-clock moment, it never depends on the time zone of the process and it is
 *    always strictly after the moment it was computed from;
 *  - the shipped defaults of the migration, because a deployment that starts unpaused
 *    or with a live schedule is the failure mode the whole rollout depends on.
 */

/** The root of the package under the boundary check. */
const PACKAGE_SRC = fileURLToPath(new URL('../../../../packages/webscan/src/', import.meta.url));

/** The migration that ships the scanner storage. */
const MIGRATION_FILE = fileURLToPath(new URL('../../migrations/0019_web_scan.sql', import.meta.url));

/** The settings the migration seeds. */
const SETTINGS_ROW_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';

/** The imports a package of the platform may not make. */
const FORBIDDEN_IMPORTS = new Set([
  'pg',
  'drizzle-orm',
  'ioredis',
  'bullmq',
  'fastify',
  'better-auth',
  'node:fs',
  'node:net',
  'node:http',
  'node:https',
  'node:child_process',
]);

/** Every TypeScript file of a directory tree. */
function readTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...readTypeScriptFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Every module specifier a file imports. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/from\s+'([^']+)'/g, /import\s+'([^']+)'/g, /import\(\s*'([^']+)'\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** The time zones the schedule arithmetic must not depend on. */
const TIME_ZONES = ['UTC', 'Asia/Kuwait', 'America/New_York', 'Australia/Lord_Howe'];

/** Runs a body with the process timezone pinned, then restores it. */
function withTimeZone<T>(timeZone: string, body: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

/** The Kuwait wall-clock reading of an instant. */
function kuwaitParts(date: Date): { date: string; hour: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const year = read('year');
  const month = read('month');
  const day = read('day');
  return {
    date: `${year}-${month}-${day}`,
    hour: read('hour'),
    weekday: read('weekday'),
  };
}

/** The check switches of the shipped defaults. */
const DEFAULT_CHECKS: CheckSwitches = {
  headers: true,
  cookies: true,
  transport: true,
  disclosure: true,
  files: true,
  active: false,
};

/** The scope of a site with no allowed path. */
function emptyScope(): ScanScope {
  return {
    hostname: 'gate.example.com',
    baseUrl: 'https://gate.example.com',
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  };
}

/** The request data of one manual scan. */
function manualRequest(overrides: Partial<ManualScanRequest> = {}): ManualScanRequest {
  return {
    siteId: overrides.siteId ?? 'gate-site',
    scope: overrides.scope ?? emptyScope(),
    checks: overrides.checks ?? DEFAULT_CHECKS,
  };
}

describe('the package boundary of the scanner (ADR-0001)', () => {
  it('imports nothing from the app or from the review engine', () => {
    const offenders: string[] = [];
    for (const file of readTypeScriptFiles(PACKAGE_SRC)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const crosses =
          specifier.includes('apps/') ||
          specifier.includes('packages/engine') ||
          specifier.startsWith('@mergepilot/engine') ||
          specifier.startsWith('@mergepilot/github');
        if (crosses) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports no storage, queue or transport infrastructure of its own', () => {
    const offenders: string[] = [];
    for (const file of readTypeScriptFiles(PACKAGE_SRC)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN_IMPORTS.has(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the schedule arithmetic of the scanner (ADR-0052 sections 5 and 7)', () => {
  const daily: WebScanSchedule = { frequency: 'daily', hour: 4, minute: 0, enabled: true };
  const weekly: WebScanSchedule = { frequency: 'weekly', weekday: 5, hour: 4, minute: 0, enabled: true };
  const monthly: WebScanSchedule = { frequency: 'monthly', dayOfMonth: 31, hour: 4, minute: 0, enabled: true };
  const biweekly: WebScanSchedule = {
    frequency: 'biweekly',
    weekday: 5,
    hour: 4,
    minute: 0,
    enabled: true,
    anchorDate: '2026-01-02',
  };
  const rules = [daily, weekly, monthly, biweekly];

  /** The reference moments of the checks: a slot, the instants around it and a later day. */
  const references = [
    new Date('2026-11-02T00:00:00.000Z'),
    new Date('2026-11-02T01:00:00.000Z'),
    new Date('2026-11-02T01:00:00.001Z'),
    new Date('2026-11-06T04:00:00.000Z'),
  ];

  it('returns the same slot whatever the time zone of the process is', () => {
    const reference = references[0] as Date;
    for (const rule of rules) {
      const slots = TIME_ZONES.map((zone) =>
        withTimeZone(zone, () => nextScheduledRun(rule, reference).toISOString()),
      );
      expect(new Set(slots).size).toBe(1);
    }
  });

  it('returns the scheduled slot as the wall-clock hour of Kuwait time', () => {
    for (const rule of rules) {
      const slot = withTimeZone('UTC', () => nextScheduledRun(rule, references[0] as Date));
      expect(kuwaitParts(slot).hour).toBe('04');
    }
  });

  it('returns a slot strictly after the reference moment', () => {
    for (const rule of rules) {
      for (const reference of references) {
        const slot = withTimeZone('UTC', () => nextScheduledRun(rule, reference));
        expect(slot.getTime()).toBeGreaterThan(reference.getTime());
      }
    }
  });

  it('keeps the weekday of a weekly schedule', () => {
    const slot = withTimeZone('UTC', () => nextScheduledRun(weekly, references[0] as Date));
    expect(kuwaitParts(slot).weekday).toBe('Fri');
  });

  it('clamps the monthly day to the last day of the month', () => {
    const reference = new Date('2026-01-31T05:00:00.000Z');
    const slot = withTimeZone('UTC', () => nextScheduledRun(monthly, reference));
    expect(kuwaitParts(slot).date).toBe('2026-02-28');
  });

  it('evaluates the rule that the validator produced', () => {
    const reference = new Date('2026-01-01T00:00:00.000Z');
    const rule = parseSchedule(
      { frequency: 'biweekly', weekday: 5, hour: 4, minute: 0, enabled: true },
      { savedAt: reference },
    );
    const slot = withTimeZone('UTC', () => nextScheduledRun(rule, reference));
    expect(slot.getTime()).toBeGreaterThan(reference.getTime());
    expect(kuwaitParts(slot).weekday).toBe('Fri');
  });
});

describe('the shipped defaults of the scanner (ADR-0052 sections 5 and 6)', () => {
  const sql = readFileSync(MIGRATION_FILE, 'utf8').replace(/\s+/g, ' ');

  it('starts the installation paused, with the notifications off', () => {
    expect(sql).toMatch(/paused boolean NOT NULL DEFAULT true/i);
    expect(sql).toMatch(/alerts_enabled boolean NOT NULL DEFAULT false/i);
  });

  it('ships the default schedule switched off', () => {
    expect(sql).toMatch(/default_schedule jsonb NOT NULL DEFAULT '\{[^}]*"enabled":false[^}]*\}'::jsonb/i);
  });

  it('ships no approved installation and no active check', () => {
    expect(sql).toMatch(/approved_installations jsonb NOT NULL DEFAULT '\[\]'::jsonb/i);
    expect(sql).toMatch(/checks jsonb NOT NULL DEFAULT '\{[^}]*"active":false[^}]*\}'::jsonb/i);
  });

  it('seeds exactly one settings row that a second row cannot replace', () => {
    expect(sql).toMatch(
      new RegExp(
        `INSERT INTO web_scan_settings \\(id\\) VALUES \\('${SETTINGS_ROW_ID}'::uuid\\) ON CONFLICT \\(id\\) DO NOTHING`,
        'i',
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        `CONSTRAINT web_scan_settings_single_row CHECK \\(id = '${SETTINGS_ROW_ID}'::uuid\\)`,
        'i',
      ),
    );
  });

  it('keeps the audit log append-only and free of workspace ownership', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER web_scan_audit_append_only BEFORE UPDATE OR DELETE ON web_scan_audit/i,
    );
    expect(sql).not.toMatch(/organization_id/i);
  });
});

describe('the fingerprint of a manual request (ADR-0052 section 7)', () => {
  it('gives the same fingerprint to the same request data', () => {
    expect(requestFingerprint(manualRequest())).toBe(requestFingerprint(manualRequest()));
  });

  it('gives a different fingerprint to a different request', () => {
    const other = manualRequest({
      scope: { ...emptyScope(), crawlPaths: [{ path: '/docs', kind: 'prefix' }] },
    });
    expect(requestFingerprint(manualRequest())).not.toBe(requestFingerprint(other));
  });

  it('ignores the order of the keys of the request data', () => {
    const forward = manualRequest();
    const backward = {
      checks: forward.checks,
      scope: forward.scope,
      siteId: forward.siteId,
    };
    expect(requestFingerprint(forward)).toBe(requestFingerprint(backward));
  });

  it('covers the request only, never the effective settings', () => {
    // The fingerprint is computed from the request alone. The limits, the checks and
    // the contact of the installation are server side defaults, so a change of them
    // can never turn a replay of the same request into a conflict.
    const request = manualRequest();
    expect(Object.keys(request).sort()).toEqual(['checks', 'scope', 'siteId']);
    expect(requestFingerprint(request)).toBe(
      requestFingerprint({ siteId: request.siteId, scope: request.scope, checks: request.checks }),
    );
  });

  it('separates a request with an override from a request without one', () => {
    const without: ManualScanRequest = { siteId: 'gate-site' };
    expect(requestFingerprint(without)).not.toBe(requestFingerprint(manualRequest()));
  });
});
