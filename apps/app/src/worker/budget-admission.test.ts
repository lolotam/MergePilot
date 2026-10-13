import { describe, expect, it } from 'vitest';
import { BudgetAdmission } from './budget-admission.js';

const under = (spent: number, budget: number) => async (reserved: number) => spent + reserved < budget;

describe('BudgetAdmission', () => {
  it('admits first come, first served: with $5 and $1 reviews, five of eight parallel reviews run', async () => {
    const admission = new BudgetAdmission();
    const results = await Promise.all(Array.from({ length: 8 }, () => admission.admit('ws', 1, under(0, 5))));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.slice(0, 5).every(Boolean)).toBe(true);
    expect(admission.heldUsd('ws')).toBe(5);
  });

  it('frees the reservation when a review finishes, once only', async () => {
    const admission = new BudgetAdmission();
    const release = await admission.admit('ws', 3, under(0, 3));
    expect(await admission.admit('ws', 3, under(0, 3))).toBeNull();
    release!();
    release!();
    expect(admission.heldUsd('ws')).toBe(0);
    expect(await admission.admit('ws', 3, under(0, 3))).not.toBeNull();
  });

  it('keeps workspaces apart', async () => {
    const admission = new BudgetAdmission();
    await admission.admit('a', 5, under(0, 5.5));
    expect(await admission.admit('b', 5, under(0, 5.5))).not.toBeNull();
    expect(admission.heldUsd('a')).toBe(5);
  });

  it('serializes the check: the next review waits for the slow spend read of the one before', async () => {
    const admission = new BudgetAdmission();
    const order: string[] = [];
    const slow = admission.admit('ws', 1, async (r) => { order.push('first-start'); await new Promise((x) => setTimeout(x, 20)); order.push('first-end'); return r < 5; });
    const fast = admission.admit('ws', 1, async (r) => { order.push(`second sees ${r}`); return r < 5; });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first-start', 'first-end', 'second sees 1']);
  });

  it('a check that throws frees the turn for the next review and holds nothing', async () => {
    const admission = new BudgetAdmission();
    await expect(admission.admit('ws', 1, async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await admission.admit('ws', 1, under(0, 5))).not.toBeNull();
    expect(admission.heldUsd('ws')).toBe(1);
  });
});
