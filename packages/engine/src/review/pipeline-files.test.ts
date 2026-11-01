import { describe, expect, it } from 'vitest';
import { makeAnswerJson, makeConfig, makeModel, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

describe('runReview — file handling', () => {
  it('marks result incomplete when a file has a truncated patch', async () => {
    const model = makeModel(makeAnswerJson([]));
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [
        // Has changes but no patch → truncated
        { path: 'src/big.ts', status: 'modified', patch: undefined, changes: 500 },
      ],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons.some((r) => r.includes('src/big.ts'))).toBe(true);
    }
  });

  it('marks result complete when all files are reviewable', async () => {
    const model = makeModel(makeAnswerJson());
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(true);
    }
  });

  // ── Excluded files not sent to model ──────────────────────────────────────

  it('excludes lock files from review', async () => {
    let capturedUser = '';
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: async (req) => {
        capturedUser = req.user;
        return { text: makeAnswerJson([]), finishReason: 'stop' };
      },
    };

    await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [
        { path: 'pnpm-lock.yaml', status: 'modified', patch: SIMPLE_PATCH, changes: 10 },
        { path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 },
      ],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(capturedUser).toContain('pnpm-lock.yaml | skip-generated');
    expect(capturedUser).not.toContain('UNTRUSTED:PATCH:pnpm-lock.yaml');
    expect(capturedUser).toContain('src/index.ts');
  });

  // ── Removed files not sent to model ─────────────────────────────────────

  it('skips removed files', async () => {
    let capturedUser = '';
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: async (req) => {
        capturedUser = req.user;
        return { text: makeAnswerJson([]), finishReason: 'stop' };
      },
    };

    await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [
        { path: 'src/old.ts', status: 'removed', patch: SIMPLE_PATCH, changes: 3 },
        { path: 'src/new.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 },
      ],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(capturedUser).toContain('src/old.ts | skip-removed');
    expect(capturedUser).not.toContain('UNTRUSTED:PATCH:src/old.ts');
    expect(capturedUser).toContain('src/new.ts');
  });

  // ── fenced JSON from model ─────────────────────────────────────────────────

  it('parses fenced JSON from model response', async () => {
    const fenced = '```json\n' + makeAnswerJson() + '\n```';
    const model = makeModel(fenced);
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
  });
});
