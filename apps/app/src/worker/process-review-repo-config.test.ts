import { describe, expect, it } from 'vitest';
import { createHarness } from './model-settings.fixtures.js';
import { finding, panelSetup } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// A repo file written for the SaaS App leaves `provider` and `model` to the dashboard. It used to
// fail every bot with "Invalid .mergepilot.yml: provider: required" (lolotam/eyadex#73).

const DASHBOARD_ONLY_YAML = `
language: ar
review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md
budget:
  perReviewUsd: 1.0
`;

describe('processReviewJob — a repo .mergepilot.yml without provider', () => {
  it('reviews with the dashboard provider and model and keeps the repo review settings', async () => {
    const h = createHarness({
      settings: {},
      repoFiles: { '.mergepilot.yml': DASHBOARD_ONLY_YAML, 'CLAUDE.md': '# Rules' },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    const config = h.getCapturedConfig();
    expect(config?.provider).toBe('anthropic');
    expect(config?.model).toBe('claude-3-5-sonnet');
    expect(config?.review.maxFindings).toBe(5);
    expect(config?.budget.perReviewUsd).toBe(1);
  });

  it('runs a panel of 5 bots, each on its own dashboard provider and model', async () => {
    const h = await panelSetup({
      repoFiles: { '.mergepilot.yml': DASHBOARD_ONLY_YAML },
      bots: [
        { slot: 2 },
        { slot: 3, provider: 'gemini', model: 'g-model' },
        { slot: 4 },
        { slot: 5, provider: 'anthropic', model: 'a-model' },
      ],
      findings: { 'main-model': [finding('Main issue')], 'g-model': [finding('Gemini issue')] },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    const runs = await h.runs();
    expect(runs.map((r) => [r.botSlot, r.status, r.provider, r.model])).toEqual([
      [1, 'completed', 'anthropic', 'main-model'],
      [2, 'completed', 'openai', 'bot2-model'],
      [3, 'completed', 'gemini', 'g-model'],
      [4, 'completed', 'openai', 'bot4-model'],
      [5, 'completed', 'anthropic', 'a-model'],
    ]);
    expect(h.created).toHaveLength(5);
  });

  it('still fails a repo file that is invalid for another reason', async () => {
    const h = createHarness({ settings: {}, repoFiles: { '.mergepilot.yml': 'review:\n  maxFindings: 50\n' } });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/review\.maxFindings/);
  });
});
