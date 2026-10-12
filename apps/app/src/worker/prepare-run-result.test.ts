import { describe, expect, it } from 'vitest';
import { Secret, type Finding } from '@mergepilot/engine';
import { prepareRunResult } from './prepare-run-result.js';

describe('prepareRunResult', () => {
  function makeFinding(idx: number, overrides?: Partial<Finding>): Finding {
    return {
      id: `f${idx}`,
      path: `src/file_${idx}.ts`,
      line: idx + 1,
      side: 'RIGHT',
      title: `Finding title ${idx}`,
      body: `Body explanation for finding ${idx}`,
      severity: 'medium',
      category: 'correctness',
      evidence: 'evidence',
      confidence: 0.9,
      ...overrides,
    };
  }

  it('structures payload with v: 1, summary, highlights, findings, usage and verification', () => {
    const summary = 'Summary header\n- Highlight 1\n- Highlight 2\nSummary paragraph';
    const inline = [makeFinding(1), makeFinding(2)];
    const outOfDiff = [makeFinding(3)];

    const result = prepareRunResult({
      summary,
      inlineFindings: inline,
      summaryOnlyFindings: outOfDiff,
      language: 'en',
      usage: { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0 },
      verification: { checked: 3, rejected: 1 },
    });

    expect(result.v).toBe(1);
    expect(result.summary).toContain('Summary header');
    expect(result.highlights).toEqual(['Highlight 1', 'Highlight 2']);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.path).toBe('src/file_1.ts');
    expect(result.outOfDiff).toHaveLength(1);
    expect(result.outOfDiff?.[0]?.path).toBe('src/file_3.ts');
    expect(result.language).toBe('en');
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 250 });
    expect(result.verify).toEqual({ dropped: 1 });
  });

  it('redacts secrets placed in finding title, body, and suggestion using runtime-built fake', () => {
    // Hard rule: no secret literal in tests! Build at runtime:
    const prefix = 'sk-';
    const bodyPart = 'proj-';
    const rand = '1234567890abcdefghijklmnopqrstuvwxyz';
    const fakeKey = `${prefix}${bodyPart}${rand}`;
    const secret = new Secret(fakeKey);

    const inline = [
      makeFinding(1, {
        title: `Found ${fakeKey} in code`,
        body: `Potential leak: ${fakeKey}`,
        suggestion: `Use env var instead of ${fakeKey}`,
      }),
    ];

    const result = prepareRunResult({
      summary: `Discovered key: ${fakeKey}`,
      inlineFindings: inline,
      language: 'en',
      knownSecrets: [secret],
    });

    expect(result.summary).not.toContain(fakeKey);
    expect(result.summary).toContain('[REDACTED:');
    expect(result.findings[0]?.title).not.toContain(fakeKey);
    expect(result.findings[0]?.body).not.toContain(fakeKey);
    expect(result.findings[0]?.suggestion).not.toContain(fakeKey);
  });

  it('caps at most 200 findings when input has more than 200', () => {
    const inline: Finding[] = [];
    for (let i = 1; i <= 250; i++) {
      inline.push(makeFinding(i));
    }

    const result = prepareRunResult({
      summary: 'Large review',
      inlineFindings: inline,
      language: 'en',
    });

    const totalFindings = result.findings.length + (result.outOfDiff?.length ?? 0);
    expect(totalFindings).toBeLessThanOrEqual(200);
    expect(result.findings.length).toBe(200);
  });

  it('caps serialized JSON at 200 KB and marks truncated: true on truncated bodies', () => {
    // Create findings with huge body content exceeding 300 KB
    const bigString = 'x'.repeat(10_000);
    const inline: Finding[] = [];
    for (let i = 1; i <= 35; i++) {
      inline.push(makeFinding(i, { body: bigString }));
    }

    const result = prepareRunResult({
      summary: 'Heavy findings review',
      inlineFindings: inline,
      language: 'ar',
    });

    const serialized = JSON.stringify(result);
    const byteSize = Buffer.byteLength(serialized, 'utf8');
    expect(byteSize).toBeLessThanOrEqual(200 * 1024);

    // At least one finding body was truncated and marked truncated: true
    const hasTruncated = result.findings.some((f) => f.truncated === true);
    expect(hasTruncated).toBe(true);
  });
});
