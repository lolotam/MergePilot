import { describe, expect, it } from 'vitest';
import { LlmAdapter, type OutputTokenRequest } from '../llm/adapter.js';
import type { GenerateOptions, StreamChunk } from '../llm/types.js';
import { modelFromAdapter } from '../review/model.js';
import { answerTokensWithin, knownMaxOutputTokens } from './output-limits.js';

/** An adapter with a 2,048-token thinking headroom and the given output limit. */
class LimitedAdapter extends LlmAdapter {
  readonly provider = 'fake';
  sent: number | undefined;

  constructor(private readonly limit: number | undefined) {
    super();
  }

  override requestedOutputTokens(options: OutputTokenRequest): number {
    return options.maxOutputTokens + 2048;
  }

  override outputLimit(): number | undefined {
    return this.limit;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.sent = this.requestedOutputTokens(options);
    yield { type: 'text-delta', text: '{}' };
    yield { type: 'finish', reason: 'stop' };
  }
}

describe('model output limits (ADR-0033)', () => {
  it('reads the limit from the bundled catalog for mapped providers only', () => {
    expect(knownMaxOutputTokens('anthropic', 'claude-fable-5')).toBe(128_000);
    expect(knownMaxOutputTokens('anthropic', 'no-such-model')).toBeUndefined();
    expect(knownMaxOutputTokens('custom', 'claude-fable-5')).toBeUndefined();
  });

  it.each([
    ['no known limit', undefined, 16_024, 18_072, 16_024],
    ['a request within the limit', 32_000, 16_024, 18_072, 16_024],
    ['a request over the limit, headroom kept', 8192, 16_024, 18_072, 6144],
    ['headroom alone over the limit', 8192, 4096, 12_288, 4096],
  ])('answerTokensWithin: %s', (_case, limit, answer, requested, expected) => {
    expect(answerTokensWithin(limit, answer, requested)).toBe(expected);
  });

  it('clamps every call of an API-key model to its limit and prices the clamped request', async () => {
    const adapter = new LimitedAdapter(8192);
    const model = modelFromAdapter(adapter, 'small');
    expect(model.answerTokensFor?.(16_024)).toBe(6144);
    expect(model.outputTokensFor?.(16_024)).toBe(8192);
    await model.generate({ system: 'S', user: 'U', maxOutputTokens: 16_024 });
    expect(adapter.sent).toBe(8192);
  });

  it('leaves the budget alone when the limit is unknown', async () => {
    const adapter = new LimitedAdapter(undefined);
    const model = modelFromAdapter(adapter, 'unknown');
    expect(model.answerTokensFor?.(16_024)).toBe(16_024);
    await model.generate({ system: 'S', user: 'U', maxOutputTokens: 16_024 });
    expect(adapter.sent).toBe(18_072);
  });
});
