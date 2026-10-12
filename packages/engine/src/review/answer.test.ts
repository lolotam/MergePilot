import { describe, expect, it } from 'vitest';
import { parseReviewAnswer, ReviewAnswerSchema } from './answer.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    title: 'Null dereference',
    body: 'Could throw if x is null.',
    severity: 'high',
    category: 'correctness',
    evidence: 'x.doSomething()',
    confidence: 0.9,
    ...overrides,
  };
}

function validAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Looks mostly fine.',
    findings: [validFinding()],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// ReviewAnswerSchema
// ---------------------------------------------------------------------------

describe('ReviewAnswerSchema', () => {
  it('accepts a valid answer', () => {
    const result = ReviewAnswerSchema.safeParse(JSON.parse(validAnswer()));
    expect(result.success).toBe(true);
  });

  it('rejects missing summary', () => {
    const obj = JSON.parse(validAnswer());
    delete (obj as Record<string, unknown>).summary;
    expect(ReviewAnswerSchema.safeParse(obj).success).toBe(false);
  });

  it('rejects findings with invalid severity', () => {
    const obj = JSON.parse(validAnswer({ findings: [validFinding({ severity: 'extreme' })] }));
    expect(ReviewAnswerSchema.safeParse(obj).success).toBe(false);
  });

  it('is compatible with z.toJSONSchema', () => {
    const schema = z.toJSONSchema(ReviewAnswerSchema);
    expect(typeof schema).toBe('object');
    expect(schema).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseReviewAnswer — happy path
// ---------------------------------------------------------------------------

describe('parseReviewAnswer', () => {
  it('parses a clean JSON object', () => {
    const result = parseReviewAnswer(validAnswer());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe('Looks mostly fine.');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.id).toBe('f1');
      expect(result.droppedInvalid).toBe(0);
    }
  });

  it('assigns sequential ids starting from f1', () => {
    const ans = JSON.stringify({
      summary: 'Two findings.',
      findings: [validFinding(), validFinding({ title: 'Second', line: 20 })],
    });
    const result = parseReviewAnswer(ans);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings[0]?.id).toBe('f1');
      expect(result.findings[1]?.id).toBe('f2');
    }
  });

  it('defaults side to RIGHT when omitted', () => {
    const ans = JSON.stringify({
      summary: 'ok',
      findings: [validFinding({ side: undefined })],
    });
    const result = parseReviewAnswer(ans);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings[0]?.side).toBe('RIGHT');
    }
  });

  // ── Fence / prose tolerance ──────────────────────────────────────────────

  it('extracts JSON from ```json fence', () => {
    const fenced = '```json\n' + validAnswer() + '\n```';
    const result = parseReviewAnswer(fenced);
    expect(result.ok).toBe(true);
  });

  it('extracts JSON from ``` fence without language tag', () => {
    const fenced = '```\n' + validAnswer() + '\n```';
    const result = parseReviewAnswer(fenced);
    expect(result.ok).toBe(true);
  });

  it('extracts JSON surrounded by prose', () => {
    const withProse = 'Here is my review:\n\n' + validAnswer() + '\n\nHope that helps!';
    const result = parseReviewAnswer(withProse);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe('Looks mostly fine.');
    }
  });

  // ── Drop invalid individual findings ──────────────────────────────────────

  it('drops an invalid finding and keeps valid ones', () => {
    const ans = JSON.stringify({
      summary: 'Mixed.',
      findings: [
        validFinding(),
        { ...validFinding({ title: 'Bad severity', severity: 'INVALID_SEVERITY' }) },
        validFinding({ title: 'Third', line: 30 }),
      ],
    });
    const result = parseReviewAnswer(ans);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(2);
      expect(result.droppedInvalid).toBe(1);
      expect(result.findings[0]?.id).toBe('f1');
      expect(result.findings[1]?.id).toBe('f2');
    }
  });

  it('returns all findings dropped and droppedInvalid=N when all invalid', () => {
    const ans = JSON.stringify({
      summary: 'All bad.',
      findings: [
        validFinding({ severity: 'NOPE' }),
        validFinding({ line: -1 }),
      ],
    });
    const result = parseReviewAnswer(ans);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(0);
      expect(result.droppedInvalid).toBe(2);
    }
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  it('returns error when no JSON object is found', () => {
    const result = parseReviewAnswer('No JSON here at all.');
    expect(result.ok).toBe(false);
  });

  it('returns error when JSON is malformed', () => {
    const result = parseReviewAnswer('{summary: oops, }');
    expect(result.ok).toBe(false);
  });

  it('returns error when top-level schema is invalid (missing summary)', () => {
    const result = parseReviewAnswer(JSON.stringify({ findings: [] }));
    expect(result.ok).toBe(false);
  });

  it('returns ok with empty findings array', () => {
    const result = parseReviewAnswer(JSON.stringify({ summary: 'clean', findings: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(0);
      expect(result.droppedInvalid).toBe(0);
    }
  });

  // ── Reproduce & Error codes (P0.1) ───────────────────────────────────────

  it('reproduces truncated JSON mid-way with finishReason max-tokens', () => {
    const truncatedText = '{"summary": "Looks mostly good so far", "findings": [{"path": "src/foo.ts", "line": 10, "title": "Trunc';
    const result = parseReviewAnswer(truncatedText, {
      finishReason: 'max-tokens',
      outputTokens: 4096,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('truncated');
      expect(result.error).toContain('max-tokens');
      expect(result.error).toContain('4096');
    }
  });

  it('detects unclosed JSON object as truncated even without finishReason', () => {
    const truncatedText = '{"summary": "Incomplete json", "findings": [';
    const result = parseReviewAnswer(truncatedText);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('truncated');
    }
  });

  it('returns empty-response error code for empty or whitespace-only response', () => {
    const emptyResult = parseReviewAnswer('');
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) {
      expect(emptyResult.code).toBe('empty-response');
    }

    const whitespaceResult = parseReviewAnswer('   \n\t  ');
    expect(whitespaceResult.ok).toBe(false);
    if (!whitespaceResult.ok) {
      expect(whitespaceResult.code).toBe('empty-response');
    }
  });

  it('extracts valid review answer when response contains multiple objects', () => {
    const twoObjects = [
      'Here is metadata: {"step": "review", "status": "running"}',
      'And here is the answer: ' + validAnswer(),
    ].join('\n\n');

    const result = parseReviewAnswer(twoObjects);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe('Looks mostly fine.');
      expect(result.findings).toHaveLength(1);
    }
  });

  it('returns invalid-json error code when text is not JSON and not truncated', () => {
    const result = parseReviewAnswer('Just some random text with no braces at all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-json');
    }
  });
});
