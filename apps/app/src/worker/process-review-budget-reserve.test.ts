import { describe, expect, it } from 'vitest';
import { HEAD, panelSetup, WS } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// With several reviews running at once (WORKER_CONCURRENCY), every job used to read the same
// month spend before any of them recorded its cost. Other jobs' in-flight runs now count at the
// per-review budget, so parallel jobs cannot all pass the monthly budget together.

async function otherJobRunning(store: Awaited<ReturnType<typeof panelSetup>>['store']) {
  await store.createReviewRun({
    workspaceId: WS, jobId: 'other-job', installationId: 31, repoFullName: 'acme/other', pullNumber: 1, headSha: HEAD,
    status: 'running', costUsd: null, detail: null, provider: 'anthropic', model: 'main-model', effort: null, botSlot: 1, botName: 'MergePilot',
  });
}

describe('processReviewJob — monthly budget with reviews running in parallel', () => {
  it('reserves another job’s running review at the per-review budget and skips when that reaches the month budget', async () => {
    // Spent 9.5 of 10; one other review running reserves the default per-review budget (1.0).
    const h = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 9.5 });
    await otherJobRunning(h.store);
    const result = await processReviewJob(h.job, h.deps);
    expect(result).toEqual({ status: 'skipped', detail: 'monthly budget reached' });
  });

  it('still reviews when the spend plus the reserved in-flight reviews stays under the budget', async () => {
    const h = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 5 });
    await otherJobRunning(h.store);
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('completed');
  });

  it('does not count the job’s own runs as reserved', async () => {
    const h = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 9.5 });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('completed');
  });
});
