import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';

import { groupOccurrences } from './group.js';
import {
  buildScanReport,
  renderReportHtml,
  renderReportJson,
  trustedDashboardUrl,
  type ReportInput,
} from './report.js';
import { htmlElements } from './checks/shared.js';
import type { CoverageEntry, OccurrenceRecord } from './types.js';

const NOW = 1_700_000_000_000;

/** One occurrence record. */
function record(overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord {
  return {
    occurrenceKey: 'occurrence-1',
    targetKey: 'target-1',
    issueKey: 'headers|missing-strict-transport-security|example.com',
    checkId: 'headers',
    issueId: 'missing-strict-transport-security',
    subject: 'strict-transport-security',
    severity: 'medium',
    validation: 'Confirmed',
    confidence: 'high',
    safeLocation: 'https://example.com/',
    evidenceHash: 'v1:hash-1',
    evidence: { header: 'strict-transport-security' },
    state: 'outstanding',
    comparison: 'Unchanged',
    ...overrides,
  };
}

/** One coverage row. */
function row(overrides: Partial<CoverageEntry> = {}): CoverageEntry {
  return {
    targetKey: 'target-1',
    checkId: 'headers',
    checkVersion: 1,
    evaluatedIssueIds: ['missing-strict-transport-security'],
    outcome: 'checked',
    subjectScope: { kind: 'complete' },
    ...overrides,
  };
}

/** The input of a report. */
function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    site: { hostname: 'example.com' },
    scan: {
      status: 'completed',
      partialCoverage: false,
      requests: 4,
      pages: 1,
      durationMs: 900,
    },
    groups: groupOccurrences([record()], { now: NOW }),
    coverage: [row()],
    ...overrides,
  };
}

describe('the machine report', () => {
  it('is valid JSON that round-trips', () => {
    const report = buildScanReport(input());
    const json = renderReportJson(report);

    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it('carries the groups, the coverage and the limitations', () => {
    const report = buildScanReport(input());

    expect(report.schema).toBe('mergepilot.webscan.report');
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.occurrences).toHaveLength(1);
    expect(report.coverage.checked).toBe(1);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it('counts the states of the occurrences', () => {
    const report = buildScanReport(
      input({
        groups: groupOccurrences(
          [
            record({ occurrenceKey: 'occurrence-1' }),
            record({
              occurrenceKey: 'occurrence-2',
              targetKey: 'target-2',
              state: 'fixed',
              comparison: 'Fixed',
            }),
            record({
              occurrenceKey: 'occurrence-3',
              targetKey: 'target-3',
              state: 'archived',
              comparison: 'Not checked',
              archiveReason: 'unobserved_retention',
              evidence: null,
            }),
          ],
          { now: NOW },
        ),
      }),
    );

    expect(report.summary.outstandingOccurrences).toBe(1);
    expect(report.summary.fixedOccurrences).toBe(1);
    expect(report.summary.archivedOccurrences).toBe(1);
  });

  it('never calls an unchecked row fixed', () => {
    const report = buildScanReport(
      input({
        coverage: [row({ outcome: 'not-visited', reason: 'disabled', evaluatedIssueIds: [] })],
        groups: groupOccurrences([record({ comparison: 'Not checked' })], { now: NOW }),
      }),
    );

    expect(report.coverage.checked).toBe(0);
    expect(report.groups[0]?.occurrences[0]?.comparison).toBe('Not checked');
    expect(JSON.stringify(report)).not.toContain('"Fixed"');
  });

  it('renders the pruned evidence of an archived occurrence explicitly', () => {
    const report = buildScanReport(
      input({
        groups: groupOccurrences(
          [
            record({
              occurrenceKey: 'occurrence-1',
              state: 'archived',
              comparison: 'Not checked',
              archiveReason: 'unobserved_retention',
              evidence: null,
            }),
          ],
          { now: NOW },
        ),
      }),
    );

    expect(report.groups[0]?.occurrences[0]?.evidence).toBeNull();
    expect(report.groups[0]?.occurrences[0]?.archiveReason).toBe('unobserved_retention');
  });

  it('keeps every retained row', () => {
    const report = buildScanReport(
      input({
        groups: groupOccurrences(
          [
            record({ occurrenceKey: 'occurrence-1' }),
            record({
              occurrenceKey: 'occurrence-2',
              targetKey: 'target-2',
              state: 'archived',
              comparison: 'Not checked',
              archiveReason: 'unobserved_retention',
              evidence: null,
            }),
            record({
              occurrenceKey: 'occurrence-3',
              targetKey: 'target-3',
              state: 'fixed',
              comparison: 'Fixed',
            }),
          ],
          { now: NOW },
        ),
      }),
    );

    expect(report.groups[0]?.occurrences.map((occurrence) => occurrence.occurrenceKey)).toEqual([
      'occurrence-1',
      'occurrence-2',
      'occurrence-3',
    ]);
  });

  it('carries no raw response, body or url field', () => {
    const report = buildScanReport(input());
    const json = renderReportJson(report);

    for (const forbidden of ['"body"', '"rawResponse"', '"response"', '"url"', '"query"']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('names the risk factors of the group', () => {
    const report = buildScanReport(input());
    const risk = report.groups[0]?.risk;

    expect(risk?.score).toBeCloseTo(5, 10);
    expect(risk?.factors).toEqual({
      severityBase: 5,
      confidence: 1,
      validation: 1,
      surface: 1,
      affectedUrls: 1,
    });
    expect(risk?.source?.occurrenceKey).toBe('occurrence-1');
  });
});

describe('the limitations of a report', () => {
  it('name a stopped scan', () => {
    const report = buildScanReport(
      input({ scan: { status: 'stopped', reason: 'request_limit', partialCoverage: true, requests: 4, pages: 1, durationMs: 900 } }),
    );
    expect(report.limitations.join(' ')).toContain('stopped');
  });

  it('name a failed scan', () => {
    const report = buildScanReport(
      input({ scan: { status: 'failed', reason: 'transport_error', partialCoverage: true, requests: 0, pages: 0, durationMs: 10 } }),
    );
    expect(report.limitations.join(' ')).toContain('failed');
  });

  it('name a partial coverage', () => {
    const report = buildScanReport(
      input({ scan: { status: 'completed', partialCoverage: true, requests: 4, pages: 1, durationMs: 900 } }),
    );
    expect(report.limitations.join(' ')).toContain('part');
  });

  it('say that the risk score is not a CVSS score', () => {
    const report = buildScanReport(input());
    expect(report.limitations.join(' ')).toContain('not a CVSS score');
  });
});

describe('the standalone HTML report', () => {
  it('needs no external script and no content delivery network', () => {
    const html = renderReportHtml(buildScanReport(input()));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
    expect(html).toContain('<style>');
  });

  it('renders the executive summary, the findings, the coverage and the limitations', () => {
    const html = renderReportHtml(buildScanReport(input()));

    expect(html).toContain('Executive summary');
    expect(html).toContain('Technical findings');
    expect(html).toContain('Coverage');
    expect(html).toContain('Limitations');
    expect(html).toContain('missing-strict-transport-security');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Unchanged');
  });

  it('never calls an unchecked row fixed', () => {
    const html = renderReportHtml(
      buildScanReport(
        input({
          coverage: [row({ outcome: 'not-visited', reason: 'disabled', evaluatedIssueIds: [] })],
          groups: groupOccurrences([record({ comparison: 'Not checked' })], { now: NOW }),
        }),
      ),
    );

    expect(html).toContain('Not checked');
    expect(html).not.toContain('>Fixed<');
  });

  it('renders the pruned evidence of an archived occurrence explicitly', () => {
    const html = renderReportHtml(
      buildScanReport(
        input({
          groups: groupOccurrences(
            [
              record({
                occurrenceKey: 'occurrence-1',
                state: 'archived',
                comparison: 'Not checked',
                archiveReason: 'unobserved_retention',
                evidence: null,
              }),
            ],
            { now: NOW },
          ),
        }),
      ),
    );

    expect(html).toContain('Evidence not retained');
    expect(html).toContain('unobserved_retention');
  });

  it('shows the location as text and never as a link', () => {
    const html = renderReportHtml(buildScanReport(input()));
    expect(html).toContain('https://example.com/');
    expect(html).not.toContain('href="https://example.com/"');
  });
});

describe('the escaping of the HTML report', () => {
  const hostile = '</script><script>alert(1)</script>';
  const hostileAttribute = '"><img src=x onerror=alert(1)>';

  it('keeps a hostile subject inert', () => {
    const html = renderReportHtml(
      buildScanReport(
        input({
          groups: groupOccurrences([record({ subject: hostile, safeLocation: hostileAttribute })], { now: NOW }),
        }),
      ),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    const document = parse(html);
    const elements = htmlElements(html);
    expect(elements.some((element) => element.nodeName === 'script')).toBe(false);
    expect(
      elements.some((element) =>
        element.attrs.some((attribute) => attribute.name.toLowerCase().startsWith('on')),
      ),
    ).toBe(false);
    expect(document).toBeTruthy();
  });

  it('keeps a hostile evidence value inert', () => {
    const html = renderReportHtml(
      buildScanReport(
        input({
          groups: groupOccurrences([record({ evidence: { header: hostile } })], { now: NOW }),
        }),
      ),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders the resolution label from the closed vocabulary', () => {
    const html = renderReportHtml(
      buildScanReport(
        input({
          groups: groupOccurrences([record()], {
            now: NOW,
            exceptions: [
              { occurrenceKey: 'occurrence-1', evidenceHash: 'v1:hash-1', kind: 'accepted', expiresAt: null },
            ],
          }),
        }),
      ),
    );

    // The kind is a closed vocabulary, so the label can never carry text of
    // its own and the report never renders an unescaped label.
    expect(html).toContain('Accepted');
    expect(html).not.toContain('<script');
  });
});

describe('the trusted dashboard link', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not-a-url', 'https://user:pw@app.example.com/admin'])('renders no anchor for a directly supplied unsafe report URL: %s', (dashboardUrl) => {
    const report = buildScanReport(input());

    const html = renderReportHtml({ ...report, dashboardUrl });

    expect(html).not.toContain('<a ');
  });

  it('is built from the configured base', () => {
    expect(
      trustedDashboardUrl({ baseUrl: 'https://app.example.com/' }, ['admin', 'web-scan', 'site 1']),
    ).toBe('https://app.example.com/admin/web-scan/site%201');
  });

  it('keeps a base path of the dashboard', () => {
    expect(trustedDashboardUrl({ baseUrl: 'https://app.example.com/mergepilot/' }, ['admin'])).toBe(
      'https://app.example.com/mergepilot/admin',
    );
  });

  it('refuses a scheme that is not http or https', () => {
    expect(trustedDashboardUrl({ baseUrl: 'javascript:alert(1)' }, ['admin'])).toBeUndefined();
    expect(trustedDashboardUrl({ baseUrl: 'data:text/html,<script>' }, ['admin'])).toBeUndefined();
    expect(trustedDashboardUrl({ baseUrl: 'file:///etc/passwd' }, ['admin'])).toBeUndefined();
  });

  it('refuses a base that carries credentials', () => {
    expect(trustedDashboardUrl({ baseUrl: 'https://user:pass@app.example.com/' }, ['admin'])).toBeUndefined();
  });

  it('refuses a base that is not a URL', () => {
    expect(trustedDashboardUrl({ baseUrl: 'not a url' }, ['admin'])).toBeUndefined();
    expect(trustedDashboardUrl({ baseUrl: '' }, ['admin'])).toBeUndefined();
  });

  it('refuses an empty segment', () => {
    expect(trustedDashboardUrl({ baseUrl: 'https://app.example.com/' }, ['admin', ''])).toBeUndefined();
  });

  it('renders no link when there is no trusted dashboard', () => {
    const report = buildScanReport(input());
    expect(report.dashboardUrl).toBeNull();
    expect(renderReportHtml(report)).not.toContain('<a ');
  });

  it('renders only the dashboard link as a link', () => {
    const report = buildScanReport(
      input({ dashboard: { baseUrl: 'https://app.example.com/' } }),
    );
    const html = renderReportHtml(report);

    expect(report.dashboardUrl).toBe('https://app.example.com/admin/web-scan');
    expect(html).toContain('href="https://app.example.com/admin/web-scan"');
    expect(html).not.toContain('href="https://example.com');
  });
});
