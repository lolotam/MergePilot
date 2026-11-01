import { describe, expect, it } from 'vitest';

import { CATALOGUE_FILE_PATHS } from '../check-requests.js';
import type { CheckId, Validation } from '../types.js';
import { createCheckContext, createTarget } from './check.fixtures.js';
import {
  CATALOGUE,
  CHECK_VERSIONS,
  EXPOSED_FILE_KINDS,
  catalogueIssue,
} from './catalogue.js';
import { buildFinding } from './shared.js';

const CHECK_IDS: readonly CheckId[] = [
  'headers',
  'cookies',
  'transport',
  'disclosure',
  'files',
  'active',
];

describe('the check catalogue', () => {
  it('gives every issue its own id', () => {
    const ids = CHECK_IDS.flatMap((checkId) =>
      CATALOGUE[checkId].map((issue) => issue.issueId),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fixes the severity and the ceiling of every issue', () => {
    for (const checkId of CHECK_IDS) {
      for (const issue of CATALOGUE[checkId]) {
        expect(['critical', 'high', 'medium', 'low', 'info']).toContain(issue.severity);
        expect(['Confirmed', 'Likely', 'Indicator', 'Informational']).toContain(
          issue.validationCeiling,
        );
        expect(issue.title.length).toBeGreaterThan(0);
      }
    }
  });

  it('records the version of every check', () => {
    for (const checkId of CHECK_IDS) {
      expect(CHECK_VERSIONS[checkId]).toBeGreaterThan(0);
      expect(Number.isInteger(CHECK_VERSIONS[checkId])).toBe(true);
    }
  });

  it('covers every fixed file path the requester allows', () => {
    expect(EXPOSED_FILE_KINDS.map((kind) => kind.path)).toEqual([...CATALOGUE_FILE_PATHS]);
  });

  it('refuses an issue that the catalogue does not know', () => {
    expect(() => catalogueIssue('headers', 'missing-nothing')).toThrow();
  });

  it('never lets a finding claim more than the ceiling of its issue', () => {
    const context = createCheckContext({
      targets: [createTarget({ url: 'https://example.com/' })],
    });

    const confirmed = buildFinding({
      context,
      targetKey: 'target',
      checkId: 'active',
      issueId: 'reflection-indicator',
      subject: 'q',
      safeLocation: 'https://example.com/',
      validation: 'Confirmed',
      confidence: 'high',
      evidence: { parameter: 'q' },
    });
    const likely = buildFinding({
      context,
      targetKey: 'target',
      checkId: 'disclosure',
      issueId: 'stack-trace-disclosure',
      subject: 'stack-trace',
      safeLocation: 'https://example.com/',
      validation: 'Confirmed',
      confidence: 'high',
      evidence: { signature: 'php-stack-trace' },
    });
    const informational = buildFinding({
      context,
      targetKey: 'target',
      checkId: 'files',
      issueId: 'robots-txt-present',
      subject: '/robots.txt',
      safeLocation: 'https://example.com/robots.txt',
      validation: 'Confirmed' as Validation,
      confidence: 'high',
      evidence: { status: 200 },
    });

    expect(confirmed.validation).toBe('Indicator');
    expect(likely.validation).toBe('Likely');
    expect(informational.validation).toBe('Informational');
  });
});
