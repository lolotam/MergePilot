import { expect, it, vi } from 'vitest';
import { ReviewDeadline } from './call.js';
import { ExploreBudget, exploreLimits } from './explore.js';
import { boundExplorationReads, EXPLORATION_TIME_EXHAUSTED } from './explore-time.js';

it('stops waiting for repository I/O at the exploration window boundary', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    const stopped = vi.fn();
    const reader = boundExplorationReads({ readFile: () => new Promise(() => {}), listDirectory: async () => null, listPaths: async () => null }, () => 400 - Date.now(), stopped);
    const rejected = expect(reader.readFile('src/a.ts')).rejects.toThrow(EXPLORATION_TIME_EXHAUSTED);
    await vi.advanceTimersByTimeAsync(400);
    await rejected;
    expect(stopped).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});

it('anchors the share once to the remaining deadline and never renews it across batches', () => {
  let now = 0;
  const deadline = new ReviewDeadline(1200000, () => now);
  const budget = new ExploreBudget(exploreLimits({}));
  now = 400000;
  expect(budget.remainingExplorationMs(deadline)).toBe(200000);
  now += 100000;
  expect(budget.remainingExplorationMs(deadline)).toBe(100000);
  now += 100000;
  expect(budget.remainingExplorationMs(deadline)).toBe(0);
  now += 100000;
  expect(budget.remainingExplorationMs(deadline)).toBe(0);
});
