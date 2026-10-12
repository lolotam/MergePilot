import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { LlmFailure } from '../llm/failure.js';
import { makeAnswerJson, makeConfig, makeFailingModel, makeModel, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { runReview } from './pipeline.js';

describe('runReview', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns completed status on valid model response', async () => {
    const model = makeModel(makeAnswerJson());
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'Fix bug', body: 'Fixes issue #1.' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.summary).toBe('Looks good.');
      expect(result.droppedInvalid).toBe(0);
    }
  });

  it('passes usage through from the model', async () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const model = makeModel(makeAnswerJson(), usage);
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
      expect(result.usage).toEqual(usage);
    }
  });

  // ── UNTRUSTED fences in prompt ────────────────────────────────────────────

  it('sends prompt with UNTRUSTED fences to model', async () => {
    let capturedRequest: ReviewModelRequest | undefined;
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: async (req) => {
        capturedRequest = req;
        return { text: makeAnswerJson(), finishReason: 'stop' };
      },
    };

    await runReview({
      config: makeConfig(),
      pr: { title: 'My PR', body: 'description' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 1 }],
      rulesFiles: [{ path: 'CLAUDE.md', content: '# Rules' }],
      model,
      knownSecrets: [],
    });

    expect(capturedRequest?.user).toContain('<<<UNTRUSTED:PR_DESCRIPTION>>>');
    expect(capturedRequest?.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:CLAUDE.md>>>');
    expect(capturedRequest?.user).toContain('<<<UNTRUSTED:PATCH:src/index.ts>>>');
  });

  // ── Arabic language ───────────────────────────────────────────────────────

  it('includes Arabic instruction in system prompt when language is ar', async () => {
    let capturedRequest: ReviewModelRequest | undefined;
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: async (req) => {
        capturedRequest = req;
        return { text: makeAnswerJson(), finishReason: 'stop' };
      },
    };

    await runReview({
      config: makeConfig({ language: 'ar' }),
      pr: { title: 'T', body: 'B' },
      files: [],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(capturedRequest?.system).toMatch(/[\u0600-\u06FF]/);
  });

  // ── Numbered lines in prompt ──────────────────────────────────────────────

  it('includes new-side line numbers in patch', async () => {
    let capturedRequest: ReviewModelRequest | undefined;
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: async (req) => {
        capturedRequest = req;
        return { text: makeAnswerJson(), finishReason: 'stop' };
      },
    };

    await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    // Added line (const b = 2) is at new-side line 2
    expect(capturedRequest?.user).toMatch(/2 \+/);
  });

  // ── Secrets redaction ─────────────────────────────────────────────────────

  it('redacts known secrets from patches before sending to model', async () => {
    const secretValue = 'sk-ant-very-secret-key-12345678';
    const secret = new Secret(secretValue);
    let capturedUser = '';
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: async (req) => {
        capturedUser = req.user;
        return { text: makeAnswerJson([]), finishReason: 'stop' };
      },
    };

    const patch = `@@ -1,1 +1,2 @@\n const x = 1;\n+const key = "${secretValue}";`;
    await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch, changes: 2 }],
      rulesFiles: [],
      model,
      knownSecrets: [secret],
    });

    expect(capturedUser).not.toContain(secretValue);
    expect(capturedUser).toContain('[REDACTED:known]');
  });

  it('creates a security finding for a secret on an added line', async () => {
    const secretValue = 'sk-ant-very-secret-key-12345678';
    const secret = new Secret(secretValue);
    // Line 2 is added
    const patch = `@@ -1,1 +1,2 @@\n const x = 1;\n+const key = "${secretValue}";`;

    const model = makeModel(makeAnswerJson([]));

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch, changes: 2 }],
      rulesFiles: [],
      model,
      knownSecrets: [secret],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const allFindings = [...result.inline, ...result.summaryOnly];
      const secFinding = allFindings.find((f) => f.category === 'security');
      expect(secFinding).toBeDefined();
      expect(secFinding?.severity).toBe('high');
    }
  });

  // ── Budget overflow ───────────────────────────────────────────────────────

  it('returns skipped-budget without calling model when budget exceeded', async () => {
    const generateMock = vi.fn();
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: generateMock,
    };

    const result = await runReview({
      config: makeConfig({
        budget: { perReviewUsd: 0.5, maxInputTokens: 1 }, // 1 token max — always exceeded
      }),
      pr: { title: 'T', body: 'B'.repeat(100) },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('skipped-budget');
    expect(generateMock).not.toHaveBeenCalled();
    if (result.status === 'skipped-budget') {
      expect(result.reason).toContain('maxInputTokens');
    }
  });

  // ── Parse failure ─────────────────────────────────────────────────────────

  it('returns failed when model returns unparseable text', async () => {
    const model = makeModel('Not JSON at all!');
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('failed');
  });

  // ── Model LlmFailure propagation ──────────────────────────────────────────

  it('propagates LlmFailure code as failed status', async () => {
    const failure = new LlmFailure({
      code: 'RATE_LIMIT',
      provider: 'anthropic',
      message: 'Rate limit exceeded',
    });
    const model = makeFailingModel(failure);

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('RATE_LIMIT');
    }
  });

  it('handles CONTEXT_WINDOW_EXCEEDED LlmFailure', async () => {
    const failure = new LlmFailure({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      provider: 'anthropic',
      message: 'Context too large',
    });
    const model = makeFailingModel(failure);

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('CONTEXT_WINDOW_EXCEEDED');
    }
  });

  // ── Invalid finding dropped ───────────────────────────────────────────────

  it('drops an invalid finding and reports droppedInvalid', async () => {
    const answer = JSON.stringify({
      summary: 'Mixed.',
      findings: [
        validFindingJson(),
        { ...validFindingJson({ severity: 'NOT_VALID_SEVERITY' }) },
      ],
    });
    const model = makeModel(answer);
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
      expect(result.droppedInvalid).toBe(1);
    }
  });

  // ── Anchoring: finding on unchanged line → summaryOnly ───────────────────

  it('places finding on an unchanged line in summaryOnly', async () => {
    // Patch: only line 2 is new (added), line 1 is context
    // Finding points to line 999 which is not in the diff at all
    const answer = JSON.stringify({
      summary: 'Has an off-diff finding.',
      findings: [validFindingJson({ line: 999 })],
    });
    const model = makeModel(answer);
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
      const allInlineIds = result.inline.map((f) => f.id);
      const allSummaryIds = result.summaryOnly.map((f) => f.id);
      // The finding at line 999 should be in summaryOnly
      expect(allSummaryIds.some((id) => id !== undefined)).toBe(true);
      // Not in inline
      const summaryFinding = result.summaryOnly.find((f) => f.line === 999);
      expect(summaryFinding).toBeDefined();
      expect(allInlineIds).not.toContain(summaryFinding?.id);
    }
  });
});

