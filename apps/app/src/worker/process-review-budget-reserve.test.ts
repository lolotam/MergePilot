import { describe, expect, it, vi } from 'vitest';
import { Secret, SUBSCRIPTION_PREFIX } from '@mergepilot/engine';
import { BudgetAdmission } from './budget-admission.js';
import { panelSetup, WS } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// Reviews of one workspace running at once: each admitted review holds its bots × the
// per-review budget (default $0.50) until it finishes, so parallel reviews cannot all pass on the
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

  it('holds the per-review budget only for bots that pay per call, never for subscription bots', async () => {
    const paid = new BudgetAdmission();
    const paidAdmit = vi.spyOn(paid, 'admit');
    const h1 = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 0, bots: [{ slot: 2 }] });
    await processReviewJob(h1.job, { ...h1.deps, budgetAdmission: paid });
    expect(paidAdmit.mock.calls[0]?.[1]).toBe(1); // two bots × the default $0.50

    const sub = new BudgetAdmission();
    const subAdmit = vi.spyOn(sub, 'admit');
    const h2 = await panelSetup({ settings: { monthlyBudgetUsd: 10 }, monthlyCost: 0, bots: [{ slot: 2 }] });
    const deps = { ...h2.deps, budgetAdmission: sub, credentials: { resolve: async () => new Secret(`${SUBSCRIPTION_PREFIX}placeholder`) } };
    await processReviewJob(h2.job, deps);
    expect(subAdmit.mock.calls[0]?.[1]).toBe(0);
  });
  it.each([undefined, 'budget:\n  perReviewUsd: 2\n'])('reserves the effective cap for each paid bot (repo override: %s)', async (file) => {
    const admission = new BudgetAdmission();
    const admit = vi.spyOn(admission, 'admit');
    const h = await panelSetup({
      settings: { monthlyBudgetUsd: 10, perReviewUsd: 3 }, bots: [{ slot: 2 }],
      ...(file ? { repoFiles: { '.mergepilot.yml': file } } : {}),
    });
    expect((await processReviewJob(h.job, { ...h.deps, budgetAdmission: admission })).status).toBe('completed');
    expect(admit.mock.calls[0]?.[1]).toBe(file ? 4 : 6);
    expect(admission.heldUsd(WS)).toBe(0);
  });

});
