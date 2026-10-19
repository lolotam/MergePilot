import { describe, expect, it } from 'vitest';
import { createHarness } from './model-settings.fixtures.js';
import { processReviewJob } from './process-review.js';

describe('workspace per-review cap through loadRepoConfig', () => {
  it.each([
    [undefined, 3],
    ['review:\n  minSeverity: low\n', 3],
    ['budget:\n  perReviewUsd: 2\n', 2],
  ] as const)('uses the workspace only when the file leaves the cap out (%s)', async (file, expected) => {
    const h = createHarness({ settings: { perReviewUsd: 3 }, ...(file ? { repoFiles: { '.mergepilot.yml': file } } : {}) });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');
    expect(h.getCapturedConfig()?.budget.perReviewUsd).toBe(expected);
  });
});
