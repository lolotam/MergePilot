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

// 2026-11-02: Waleed_Bot (600 s calls, 1200 s review) skipped exploration in every review,
// because its first round could never finish inside a 300 s window.
// setupMs is review time spent before exploration starts (classification, planning).
// Past half the remaining time, one full call stays reserved for the answers instead.
it.each([
  { callTimeoutMs: 300000, setupMs: 0, window: 300000 },
  { callTimeoutMs: 600000, setupMs: 0, window: 600000 },
  { callTimeoutMs: 600000, setupMs: 20000, window: 580000 },
  { callTimeoutMs: 630000, setupMs: 0, window: 570000 },
  { callTimeoutMs: 900000, setupMs: 0, window: 300000 },
  { callTimeoutMs: 300000, setupMs: 300000, window: 300000 },
])('gives a $callTimeoutMs ms call a $window ms window after $setupMs ms of a 1200 s review', ({ callTimeoutMs, setupMs, window }) => {
  let now = 0;
  const deadline = new ReviewDeadline(1200000, () => now);
  now = setupMs;
  expect(new ExploreBudget(exploreLimits({})).remainingExplorationMs(deadline, callTimeoutMs)).toBe(window);
});
