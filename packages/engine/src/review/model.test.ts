import { describe, expect, it } from 'vitest';
import { LlmAdapter } from '../llm/adapter.js';
import type { GenerateOptions, StreamChunk } from '../llm/types.js';
import { modelFromAdapter } from './model.js';

class FakeAdapter extends LlmAdapter {
  readonly provider = 'fake';
  seen: GenerateOptions | undefined;

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen = options;
    yield { type: 'text-delta', text: '{"ok":true}' };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: 'finish', reason: 'stop' };
  }
}

describe('modelFromAdapter', () => {
  it('sends system + user messages and returns the collected answer', async () => {
    const adapter = new FakeAdapter();
    const model = modelFromAdapter(adapter, 'm1');

    const response = await model.generate({ system: 'S', user: 'U', maxOutputTokens: 100 });

    expect(model.label).toBe('fake:m1');
    expect(adapter.seen?.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
    expect(adapter.seen?.model).toBe('m1');
    expect(response).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      finishReason: 'stop',
    });
  });

  it('passes a per-call thinking override to the adapter next to the configured effort', async () => {
    const adapter = new FakeAdapter();
    const model = modelFromAdapter(adapter, 'glm-5.3', 'on');

    await model.generate({ system: 'S', user: 'U', maxOutputTokens: 100, thinking: 'off' });
    expect(adapter.seen).toMatchObject({ effort: 'on', thinking: 'off' });

    await model.generate({ system: 'S', user: 'U', maxOutputTokens: 100 });
    expect(adapter.seen).not.toHaveProperty('thinking');
  });
});
