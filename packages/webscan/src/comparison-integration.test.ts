import { describe, expect, it } from 'vitest';

import { compareScan, identityFromFinding, occurrenceRecordFromFinding } from './compare.js';
import { groupOccurrences } from './group.js';
import { buildScanReport, renderReportHtml, renderReportJson } from './report.js';
import { runScan } from './run.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  targetKeyOf,
  textResponse,
} from './test-support.fixtures.js';
import type { CheckSwitches, RetainedOccurrence, ScanInput, ScanObservation } from './types.js';

const NOW = 1_700_000_000_000;

/** The checks of one run. */
function checks(overrides: Partial<CheckSwitches> = {}): CheckSwitches {
  return {
    headers: false,
    cookies: false,
    transport: false,
    disclosure: false,
    files: false,
    active: false,
    ...overrides,
  };
}

/** The input of one run. */
function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    scope: createScope(),
    limits: createLimits(),
    checks: checks(),
    contact: 'ops@example.com',
    ...overrides,
  };
}

/** The retained rows of the findings of a scan. */
function retainedOf(observation: ScanObservation): RetainedOccurrence[] {
  return observation.findings.map((finding) => ({ finding, state: 'outstanding' as const }));
}

/** The findings of one issue. */
function findingsOf(observation: ScanObservation, issueId: string) {
  return observation.findings.filter((finding) => finding.issueId === issueId);
}

describe('a real scan against the retained state', () => {
  it('proves an exposed file fixed when the next scan reads it as absent', async () => {
    const exposed = createFakeTransport((call) =>
      call.url.endsWith('/.env')
        ? textResponse('SECRET_ENV_VALUE=1\n', { headers: { 'content-type': 'text/plain' } })
        : textResponse('<p>hello</p>'),
    );
    const first = await runScan(input({ checks: checks({ files: true }) }), createDependencies(exposed).deps);
    expect(first.status).toBe('completed');
    expect(findingsOf(first, 'env-file-exposed')).toHaveLength(1);

    const absent = createFakeTransport((call) =>
      call.url.endsWith('/.env') ? textResponse('', { status: 404 }) : textResponse('<p>hello</p>'),
    );
    const second = await runScan(input({ checks: checks({ files: true }) }), createDependencies(absent).deps);
    expect(second.status).toBe('completed');
    expect(findingsOf(second, 'env-file-exposed')).toHaveLength(0);

    const result = compareScan(second, retainedOf(first));

    expect(result.mayBecomeBaseline).toBe(true);
    const fixed = result.updates.filter((update) => update.comparison === 'Fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ state: 'fixed' });
  });

  it('keeps the exposed file outstanding when the check is switched off', async () => {
    const exposed = createFakeTransport((call) =>
      call.url.endsWith('/.env')
        ? textResponse('SECRET_ENV_VALUE=1\n', { headers: { 'content-type': 'text/plain' } })
        : textResponse('<p>hello</p>'),
    );
    const first = await runScan(input({ checks: checks({ files: true }) }), createDependencies(exposed).deps);

    const absent = createFakeTransport((call) =>
      call.url.endsWith('/.env') ? textResponse('', { status: 404 }) : textResponse('<p>hello</p>'),
    );
    const second = await runScan(input({ checks: checks() }), createDependencies(absent).deps);
    expect(second.status).toBe('completed');

    const result = compareScan(second, retainedOf(first));

    const update = result.updates.find(
      (candidate) => candidate.state !== 'archived' && candidate.finding?.issueId === 'env-file-exposed',
    );
    expect(update).toMatchObject({ comparison: 'Not checked', state: 'outstanding' });
  });

  it('keeps the exposed file outstanding when the file could not be read', async () => {
    const exposed = createFakeTransport((call) =>
      call.url.endsWith('/.env')
        ? textResponse('SECRET_ENV_VALUE=1\n', { headers: { 'content-type': 'text/plain' } })
        : textResponse('<p>hello</p>'),
    );
    const first = await runScan(input({ checks: checks({ files: true }) }), createDependencies(exposed).deps);

    const broken = createFakeTransport((call) =>
      call.url.endsWith('/.env') ? textResponse('', { status: 500 }) : textResponse('<p>hello</p>'),
    );
    const second = await runScan(input({ checks: checks({ files: true }) }), createDependencies(broken).deps);
    expect(second.status).toBe('completed');
    expect(second.partialCoverage).toBe(true);

    const result = compareScan(second, retainedOf(first));

    const update = result.updates.find(
      (candidate) => candidate.state !== 'archived' && candidate.finding?.issueId === 'env-file-exposed',
    );
    expect(update).toMatchObject({ comparison: 'Not checked', state: 'outstanding' });
  });

  it('never proves a fix from a stopped scan whose coverage says checked', async () => {
    const missing = createFakeTransport(() => textResponse('<a href="/docs/a">doc</a>'));
    const first = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(missing).deps);
    expect(first.status).toBe('completed');
    const retained = retainedOf(first).filter((row) =>
      row.finding.issueId === 'missing-strict-transport-security',
    );
    // The first scan read two pages, so it holds one occurrence per page.
    expect(retained).toHaveLength(2);

    const fixedHeader = createFakeTransport(() =>
      textResponse('<a href="/docs/a">doc</a>', {
        headers: { 'strict-transport-security': 'max-age=31536000' },
      }),
    );
    const second = await runScan(
      input({ checks: checks({ headers: true }), limits: createLimits({ maxRequests: 1 }) }),
      createDependencies(fixedHeader).deps,
    );
    expect(second.status).toBe('stopped');
    // The scan read its page, so its coverage says checked.
    const headerRow = second.coverage.find(
      (row) => row.checkId === 'headers' && row.outcome === 'checked',
    );
    expect(headerRow?.evaluatedIssueIds).toContain('missing-strict-transport-security');

    const result = compareScan(second, retained);

    expect(result.mayBecomeBaseline).toBe(false);
    const headerUpdates = result.updates.filter(
      (update) => update.finding?.issueId === 'missing-strict-transport-security',
    );
    // The first scan read two pages, so it holds two occurrences of the issue.
    expect(headerUpdates).toHaveLength(2);
    expect(headerUpdates.every((update) => update.comparison === 'Not checked')).toBe(true);
    expect(headerUpdates.every((update) => update.state === 'outstanding')).toBe(true);
  });

  it('never proves a fix from a failed scan', async () => {
    const missing = createFakeTransport(() => textResponse('<p>hello</p>'));
    const first = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(missing).deps);
    const retained = retainedOf(first).filter((row) =>
      row.finding.issueId === 'missing-strict-transport-security',
    );

    const broken = createFakeTransport(() => new Error('connect ECONNREFUSED 127.0.0.1:443'));
    const second = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(broken).deps);
    expect(second.status).toBe('failed');

    const result = compareScan(second, retained);

    expect(result.mayBecomeBaseline).toBe(false);
    expect(result.updates[0]).toMatchObject({ comparison: 'Not checked', state: 'outstanding' });
  });

  it('reactivates an archived occurrence when a later scan observes it again', async () => {
    const missing = createFakeTransport(() => textResponse('<p>hello</p>'));
    const first = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(missing).deps);
    const archived: RetainedOccurrence[] = first.findings.map((finding) => ({
      identity: identityFromFinding(finding),
      state: 'archived',
      archiveReason: 'unobserved_retention',
    }));
    expect(archived.length).toBeGreaterThan(0);

    const second = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(missing).deps);
    const result = compareScan(second, archived);

    const reactivated = result.updates.filter((update) => update.state === 'outstanding');
    expect(reactivated.length).toBe(archived.length);
    expect(reactivated.every((update) => update.comparison === 'New')).toBe(true);
  });

  it('reactivates an archived occurrence from a stopped scan', async () => {
    const missing = createFakeTransport(() => textResponse('<a href="/docs/a">doc</a>'));
    const first = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(missing).deps);
    const archived: RetainedOccurrence[] = first.findings.map((finding) => ({
      identity: identityFromFinding(finding),
      state: 'archived',
      archiveReason: 'unobserved_retention',
    }));

    const second = await runScan(
      input({ checks: checks({ headers: true }), limits: createLimits({ maxRequests: 1 }) }),
      createDependencies(missing).deps,
    );
    expect(second.status).toBe('stopped');

    const result = compareScan(second, archived);

    // The stopped scan read the base page again, so the occurrences of that
    // page come back as outstanding.
    const reactivated = result.updates.filter(
      (update) => update.finding?.targetKey === targetKeyOf('https://example.com/'),
    );
    expect(reactivated.length).toBeGreaterThan(0);
    expect(reactivated.every((update) => update.state === 'outstanding')).toBe(true);
    expect(reactivated.every((update) => update.comparison === 'New')).toBe(true);
    // The occurrences of the page the stopped scan never reached stay archived.
    const stillArchived = result.updates.filter((update) => update.state === 'archived');
    expect(stillArchived.length).toBeGreaterThan(0);
    expect(result.mayBecomeBaseline).toBe(false);
  });

  it('keeps an archived occurrence that was never proven fixed', async () => {
    const missing = createFakeTransport(() => textResponse('<p>hello</p>'));
    const first = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(missing).deps);
    const archived: RetainedOccurrence[] = first.findings.map((finding) => ({
      identity: identityFromFinding(finding),
      state: 'archived',
      archiveReason: 'unobserved_retention',
    }));

    const fixedHeader = createFakeTransport(() =>
      textResponse('<p>hello</p>', { headers: { 'strict-transport-security': 'max-age=31536000' } }),
    );
    const second = await runScan(input({ checks: checks({ headers: true }) }), createDependencies(fixedHeader).deps);
    const result = compareScan(second, archived);

    const provenFixed = result.updates.filter((update) => update.comparison === 'Fixed');
    expect(provenFixed).toHaveLength(1);
    expect(provenFixed[0]).toMatchObject({ state: 'fixed' });
    // The archived occurrences the scan observed again come back as outstanding.
    const reactivated = result.updates.filter((update) => update.state === 'outstanding');
    expect(reactivated).toHaveLength(archived.length - 1);
    expect(reactivated.every((update) => update.comparison === 'New')).toBe(true);
  });
});

describe('the report of a real scan', () => {
  it('renders the findings of the scan as groups and as a report', async () => {
    const transport = createFakeTransport(() => textResponse('<p>hello</p>'));
    const observation = await runScan(
      input({ checks: checks({ headers: true }) }),
      createDependencies(transport).deps,
    );
    const result = compareScan(observation, []);
    const records = result.updates.map((update) =>
      occurrenceRecordFromFinding(
        update.finding!,
        update.state === 'fixed' ? 'fixed' : 'outstanding',
        update.comparison,
      ),
    );
    const groups = groupOccurrences(records, { now: NOW });

    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]?.status).toBe('open');

    const report = buildScanReport({
      site: { hostname: 'example.com' },
      scan: {
        status: observation.status,
        partialCoverage: observation.partialCoverage,
        requests: observation.requests,
        pages: observation.pages,
        durationMs: observation.durationMs,
      },
      groups,
      coverage: observation.coverage,
    });
    const json = renderReportJson(report);
    const html = renderReportHtml(report);

    expect(JSON.parse(json)).toEqual(report);
    expect(html).toContain('missing-strict-transport-security');
    expect(html).not.toContain('<script');
    // The response body of the site never reaches the report.
    expect(json).not.toContain('hello');
  });
});
