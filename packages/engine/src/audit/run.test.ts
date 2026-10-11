import { describe, expect, it, vi } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { Secret } from '../credentials/secret.js';
import type { ReviewModel } from '../review/model.js';
import { runAudit } from './run.js';

describe('runAudit', () => {
  const baseConfig: MergePilotConfig = {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    language: 'en',
    review: {
      maxFindings: 5,
      minSeverity: 'medium',
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap'],
      rulesFiles: ['CLAUDE.md'],
      pathInstructions: [],
      verify: false,
      libraryDocs: { source: 'none', maxCharsPerLibrary: 8000, maxLibraries: 5 },
    },
    budget: {
      perReviewUsd: 0.5,
      maxInputTokens: 200000,
    },
    audit: {
      enabled: true,
      output: 'summary',
      maxFiles: 200,
      include: ['**/*'],
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
    },
  };

  it('runs audit across chunks sequentially and collects findings', async () => {
    const fileContents: Record<string, string> = {
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
    };

    const generateCalls: unknown[] = [];
    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async (opts) => {
        generateCalls.push(opts);
        return {
          text: JSON.stringify({
            summary: `Audit summary for call ${generateCalls.length}`,
            findings: [
              {
                path: 'src/a.ts',
                line: 1,
                title: 'Potential issue',
                body: 'Detailed description',
                severity: 'medium',
                category: 'correctness',
                evidence: 'export const a = 1;',
                confidence: 0.8,
              },
            ],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
    };

    const result = await runAudit({
      config: baseConfig,
      rulesFiles: [{ path: 'CLAUDE.md', content: '# Rules' }],
      readFile: async (p) => fileContents[p] ?? '',
      files: [
        { path: 'src/a.ts', size: 100 },
        { path: 'src/b.ts', size: 100 },
      ],
      model: fakeModel,
    });

    expect(generateCalls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe('src/a.ts');
    expect(result.summaryByChunk).toHaveLength(1);
    expect(result.summaryByChunk[0]?.summary).toBe('Audit summary for call 1');
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.failedChunks).toHaveLength(0);
  });

  it('redacts secrets before prompt and turns them into security findings', async () => {
    const knownSecret = new Secret('super-secret-token-12345');
    const fileContents: Record<string, string> = {
      'src/config.ts': 'const token = "super-secret-token-12345";\nconst key = "sk-ant-1234567890123456";',
    };

    let receivedUserPrompt = '';
    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async (opts) => {
        receivedUserPrompt = (opts as { user: string }).user;
        return {
          text: JSON.stringify({
            summary: 'Clean code.',
            findings: [],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 30, outputTokens: 10 },
        };
      }),
    };

    const result = await runAudit({
      config: baseConfig,
      rulesFiles: [],
      readFile: async (p) => fileContents[p] ?? '',
      files: [{ path: 'src/config.ts', size: 100 }],
      model: fakeModel,
      knownSecrets: [knownSecret],
    });

    // The prompt sent to the model must NOT contain the real secret
    expect(receivedUserPrompt).not.toContain('super-secret-token-12345');
    expect(receivedUserPrompt).toContain('[REDACTED:known]');
    expect(receivedUserPrompt).toContain('[REDACTED:anthropic]');

    // Findings must contain security findings for redacted secrets
    const secFindings = result.findings.filter((f) => f.category === 'security');
    expect(secFindings.length).toBeGreaterThanOrEqual(2);
    expect(secFindings.some((f) => f.evidence.includes('[REDACTED:known]'))).toBe(true);
    expect(secFindings.some((f) => f.evidence.includes('[REDACTED:anthropic]'))).toBe(true);
  });

  it('continues remaining chunks when one chunk fails', async () => {
    // Force 2 chunks with small budget
    const tightConfig: MergePilotConfig = {
      ...baseConfig,
      budget: {
        perReviewUsd: 0.5,
        maxInputTokens: 50, // 35 token budget per chunk
      },
    };

    const fileContents: Record<string, string> = {
      'src/a.ts': 'const a = 1;',
      'src/b.ts': 'const b = 2;',
    };

    let callCount = 0;
    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error on chunk 1');
        }
        return {
          text: JSON.stringify({
            summary: 'Chunk 2 succeeded',
            findings: [
              {
                path: 'src/b.ts',
                line: 1,
                title: 'Chunk 2 issue',
                body: 'Detail',
                severity: 'high',
                category: 'correctness',
                evidence: 'const b = 2;',
                confidence: 0.9,
              },
            ],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      }),
    };

    const result = await runAudit({
      config: tightConfig,
      rulesFiles: [],
      readFile: async (p) => fileContents[p] ?? '',
      files: [
        { path: 'src/a.ts', size: 100 },
        { path: 'src/b.ts', size: 100 },
      ],
      model: fakeModel,
    });

    expect(callCount).toBe(2);
    expect(result.summaryByChunk).toHaveLength(2);
    expect(result.summaryByChunk[0]?.error).toContain('Network error on chunk 1');
    expect(result.summaryByChunk[1]?.summary).toBe('Chunk 2 succeeded');
    expect(result.failedChunks).toHaveLength(1);
    expect(result.failedChunks[0]?.paths).toEqual(['src/a.ts']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe('src/b.ts');
  });

  it('caps merged findings at maxFindings * chunks.length (max 50)', async () => {
    const configWithLowFindings: MergePilotConfig = {
      ...baseConfig,
      review: {
        ...baseConfig.review,
        maxFindings: 2,
      },
    };

    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async () => {
        return {
          text: JSON.stringify({
            summary: 'Many findings',
            findings: Array.from({ length: 10 }, (_, i) => ({
              path: 'src/a.ts',
              line: i + 1,
              title: `Issue ${i + 1}`,
              body: 'Detail',
              severity: 'medium',
              category: 'correctness',
              evidence: `line ${i + 1}`,
              confidence: 0.5,
            })),
          }),
          finishReason: 'stop' as const,
        };
      }),
    };

    const result = await runAudit({
      config: configWithLowFindings,
      rulesFiles: [],
      readFile: async () => 'code',
      files: [{ path: 'src/a.ts', size: 100 }],
      model: fakeModel,
    });

    // 1 chunk * maxFindings 2 = cap of 2
    expect(result.findings).toHaveLength(2);
  });
});
