import { describe, expect, it } from 'vitest';
import { BudgetAdmission } from './budget-admission.js';
import { panelSetup, WS } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// Reviews of one workspace running at once: each admitted review holds its bots × the
// per-review budget (default $1) until it finishes, so parallel reviews cannot all pass on the
// same spend figure, and a merely queued review never counts against another.

describe('processReviewJob — monthly budget with reviews running in parallel', () => {
  it('skips when the spend plus what admitted reviews hold reaches the month budget', async () => {
    const admission = new BudgetAdmission();
    await admission.admit(WS, 1, async () => true); // another review is running
    const h = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 9.5 });
    const result = await processReviewJob(h.job, { ...h.deps, budgetAdmission: admission });
    expect(result).toEqual({ status: 'skipped', detail: 'monthly budget reached' });
  });

  it('reviews, and frees its own reservation afterwards, when the budget allows it', async () => {
    const admission = new BudgetAdmission();
    const h = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 5, bots: [{ slot: 2 }] });
    const result = await processReviewJob(h.job, { ...h.deps, budgetAdmission: admission });
    expect(result.status).toBe('completed');
    expect(admission.heldUsd(WS)).toBe(0);
  });

  it('does not count queued reviews that were never admitted', async () => {
    const admission = new BudgetAdmission();
    const h = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 8.5 });
    const result = await processReviewJob(h.job, { ...h.deps, budgetAdmission: admission });
    expect(result.status).toBe('completed');
  });
});
