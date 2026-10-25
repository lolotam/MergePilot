import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { equivalentFields } from './subscription-equivalent.js';

const settings = { priceOverrides: [{ provider: 'openai', model: 'gpt-x', inputPerMTok: 2, outputPerMTok: 4 }] };
const noFailure = (): void => {
  throw new Error('no price lookup should fail');
};

describe('the API-equivalent of a run (ADR-0024, ADR-0047)', () => {
  it('prices only the subscription calls of a mixed subscription and API-key run', async () => {
    const fields = await equivalentFields(
      {
        // The run's whole usage holds the paid API-key call too; only the subscription part counts.
        usage: { inputTokens: 1_000, outputTokens: 950 },
        apiPrice: undefined,
        subscriptionUsage: [{ label: 'openai:gpt-x', usage: { inputTokens: 100, outputTokens: 50 } }],
        onlySubscriptionCalls: false,
        fellBack: false,
        store: new MemoryStore(),
        settings,
      },
      noFailure,
    );

    // The runs table keeps showing no equivalent for a mixed run (ADR-0024 §5): only the card's part.
    expect(fields.apiEquivalentUsd).toBeUndefined();
    expect(fields.subscriptionPart?.usd).toBeCloseTo(0.0004);
    expect(fields.subscriptionPart?.byModel).toEqual([
      { provider: 'openai', model: 'gpt-x', inputTokens: 100, outputTokens: 50, usd: 0.0004 },
    ]);
  });

  it('marks the subscription part unpriced when any of its models has no API price', async () => {
    const fields = await equivalentFields(
      {
        usage: { inputTokens: 300, outputTokens: 150 },
        apiPrice: undefined,
        subscriptionUsage: [
          { label: 'openai:gpt-x', usage: { inputTokens: 100, outputTokens: 50 } },
          { label: 'anthropic:unpriced', usage: { inputTokens: 100, outputTokens: 50 } },
        ],
        onlySubscriptionCalls: false,
        fellBack: false,
        store: new MemoryStore(),
        settings,
      },
      noFailure,
    );

    expect(fields).toEqual({ subscriptionPart: null });
  });

  it('keeps a run that stayed on its own subscription model on the ADR-0024 price', async () => {
    const fields = await equivalentFields(
      {
        usage: { inputTokens: 100, outputTokens: 50 },
        apiPrice: { pricing: { inputPerMTok: 2, outputPerMTok: 4 }, source: 'override' },
        subscriptionUsage: [{ label: 'openai:gpt-x', usage: { inputTokens: 100, outputTokens: 50 } }],
        onlySubscriptionCalls: true,
        fellBack: false,
        store: new MemoryStore(),
        settings,
      },
      noFailure,
    );

    expect(fields).toEqual({ apiEquivalentUsd: 0.0004, apiEquivalentSource: 'override' });
  });
});
