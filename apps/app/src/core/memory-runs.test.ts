import { describe, expect, it } from 'vitest';
import { compareRuns } from './memory-runs.js';
import { runDurationMs } from './run-types.js';
import type { ReviewRun, ReviewRunStatus } from './types.js';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');

function run(id: string, status: ReviewRunStatus, tookSec: number | null, finishedOffsetSec = tookSec): ReviewRun {
  return {
    id,
    workspaceId: 'ws',
    installationId: 1,
    repoFullName: 'acme/app',
    pullNumber: 1,
    headSha: id,
    status,
    costUsd: null,
    detail: null,
    createdAt: new Date(T0),
    finishedAt: finishedOffsetSec === null ? null : new Date(T0 + finishedOffsetSec * 1000),
    updatedAt: new Date(T0),
  };
}

describe('runDurationMs', () => {
  it('is finishedAt - createdAt for finished runs, null otherwise', () => {
    expect(runDurationMs(run('a', 'completed', 75))).toBe(75_000);
    expect(runDurationMs(run('b', 'skipped', 0))).toBe(0);
    expect(runDurationMs(run('c', 'failed', null))).toBeNull();
    expect(runDurationMs(run('d', 'running', null))).toBeNull();
    expect(runDurationMs(run('e', 'queued', 10))).toBeNull();
    expect(runDurationMs(run('f', 'completed', null, -5))).toBeNull();
  });
});

describe('compareRuns by duration (in-memory twin of the SQL sort)', () => {
  const runs = [run('long', 'failed', 300), run('active', 'running', null), run('short', 'completed', 5), run('none', 'failed', null)];
  const order = (dir: 'asc' | 'desc') => [...runs].sort(compareRuns('duration', dir)).map((r) => r.id);

  it('puts runs with no duration last in both directions', () => {
    expect(order('desc')).toEqual(['long', 'short', 'active', 'none']);
    expect(order('asc')).toEqual(['short', 'long', 'active', 'none']);
  });
});
