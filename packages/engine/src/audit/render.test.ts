import { describe, expect, it } from 'vitest';
import type { Finding } from '../review/types.js';
import { renderAuditReport } from './render.js';
import type { AuditResult } from './types.js';

describe('renderAuditReport', () => {
  const sampleFinding: Finding = {
    id: 'f1',
    path: 'src/auth/jwt.ts',
    line: 42,
    side: 'RIGHT',
    title: 'Hardcoded secret',
    body: 'Do not hardcode secrets.',
    severity: 'critical',
    category: 'security',
    evidence: 'const secret = "123";',
    confidence: 0.95,
  };

  const sampleResult: AuditResult = {
    findings: [sampleFinding],
    summaryByChunk: [
      { chunkIndex: 0, paths: ['src/auth/jwt.ts'], summary: 'Overall security look: 1 critical.' },
    ],
    skipped: [{ path: '.env', reason: 'sensitive' }],
    usage: { inputTokens: 100, outputTokens: 50 },
    failedChunks: [],
  };

  it('renders report in English with findings grouped by severity and path:line', () => {
    const report = renderAuditReport({
      language: 'en',
      result: sampleResult,
      modelLabel: 'anthropic:claude-3-5-sonnet',
    });

    expect(report).toContain('## MergePilot repository audit');
    expect(report).toContain('Overall security look: 1 critical.');
    expect(report).toContain('Critical');
    expect(report).toContain('`src/auth/jwt.ts:42`');
    expect(report).toContain('Hardcoded secret');
    expect(report).toContain('Skipped files');
    expect(report).toContain('`.env`');
    expect(report).toContain('sensitive');
    expect(report).toContain('MergePilot only comments and never approves or blocks merging.');
    expect(report).not.toContain('<div dir="rtl">');
  });

  it('renders report in Arabic with RTL wrapper and translated strings', () => {
    const report = renderAuditReport({
      language: 'ar',
      result: sampleResult,
      modelLabel: 'anthropic:claude-3-5-sonnet',
    });

    expect(report).toMatch(/^<div dir="rtl">[\s\S]*<\/div>$/);
    expect(report).toContain('`src/auth/jwt.ts:42`');
    expect(report).toContain('`MergePilot` يكتفي بالتعليق فقط ولا يوافق على الدمج أو يمنعه.');
  });

  it('renders failed chunks section if any chunks failed', () => {
    const resultWithFailure: AuditResult = {
      ...sampleResult,
      failedChunks: [
        {
          chunkIndex: 1,
          paths: ['src/db/query.ts'],
          error: 'Rate limit exceeded',
        },
      ],
    };

    const report = renderAuditReport({
      language: 'en',
      result: resultWithFailure,
    });

    expect(report).toContain('Failed chunks');
    expect(report).toContain('src/db/query.ts');
    expect(report).toContain('Rate limit exceeded');
  });
});
