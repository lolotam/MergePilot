import { afterEach, describe, expect, it, vi } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import type { AppStore, ReviewJob } from '../core/types.js';
import { createTestDb, type TestDbHandle } from '../db/test-db.js';
import { processReviewJob } from './process-review.js';
import type { ProcessReviewDeps } from './types.js';

const WS = 'ws-dup';
const INSTALLATION = 7;
const REPO = 'acme/dup';
const PR = 12;
const HEAD = 'sha-dup-head';

function job(deliveryId: string): ReviewJob {
  return {
    deliveryId,
    installationId: INSTALLATION,
    repoFullName: REPO,
    pullNumber: PR,
    headSha: HEAD,
    baseSha: 'sha-dup-base',
  };
}

async function seed(store: AppStore, withSettings = true): Promise<void> {
  await store.upsertInstallation({
    id: INSTALLATION,
    workspaceId: WS,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspended: false,
  });
  if (withSettings) {
    await store.saveSettings({
      workspaceId: WS,
      provider: 'anthropic',
      model: 'claude-test',
      language: 'en',
      monthlyBudgetUsd: null,
    });
  }
}

function makeDeps(store: AppStore) {
  // Any GitHub access fails, so a job that gets past run creation ends `failed`, and a duplicate
  // job (which must stop before GitHub) never calls this.
  const githubAppFactory = vi.fn(async () => {
    throw new Error('github unavailable in this test');
  });
  const credentials = { resolve: vi.fn(async () => new Secret('sk-test-dup-key-0000')) };
  const deps: ProcessReviewDeps = { store, credentials, githubAppFactory };
  return { deps, githubAppFactory, credentials };
}

const queuedRetry = (jobId: string) => ({
  workspaceId: WS,
  installationId: INSTALLATION,
  repoFullName: REPO,
  pullNumber: PR,
  headSha: HEAD,
  status: 'queued' as const,
  costUsd: null,
  detail: null,
  jobId,
});

const stores: Array<[string, () => Promise<AppStore>]> = [
  ['memory', async () => new MemoryStore()],
];
let handle: TestDbHandle | undefined;
stores.push([
  'postgres (pglite)',
  async () => {
    handle = await createTestDb(undefined, { workspaces: [WS] });
    return handle.store;
  },
]);

describe.each(stores)('processReviewJob one active run per head: %s', { timeout: 30000 }, (_name, createStore) => {
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('ends a second job for an active head as skipped `duplicate` without touching GitHub', async () => {
    const store = await createStore();
    await seed(store);
    const active = await store.createReviewRun(queuedRetry('retry-a'));
    const { deps, githubAppFactory, credentials } = makeDeps(store);

    const result = await processReviewJob(job('webhook-delivery-b'), deps);

    expect(result).toEqual({ status: 'skipped', detail: 'duplicate' });
    expect(githubAppFactory).not.toHaveBeenCalled();
    expect(credentials.resolve).not.toHaveBeenCalled();
    const runs = await store.listReviewRuns(WS, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(active.id);
    expect(runs[0]?.status).toBe('queued');
  });

  it('still reuses the queued run of its own job id (ADR-0009)', async () => {
    const store = await createStore();
    await seed(store);
    const queued = await store.createReviewRun(queuedRetry('retry-own'));
    const { deps, githubAppFactory } = makeDeps(store);

    const result = await processReviewJob(job('retry-own'), deps);

    // Reused queued -> running -> failed on the same row; no duplicate conflict with itself.
    expect(result.status).toBe('failed');
    expect(githubAppFactory).toHaveBeenCalledOnce();
    const runs = await store.listReviewRuns(WS, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(queued.id);
    expect(runs[0]?.status).toBe('failed');
  });

  it('a redelivered job whose failed run would collide with an active run is skipped', async () => {
    const store = await createStore();
    await seed(store);
    const { deps } = makeDeps(store);
    const first = await processReviewJob(job('job-x'), deps);
    expect(first.status).toBe('failed');
    const active = await store.createReviewRun(queuedRetry('retry-y'));

    const again = await processReviewJob(job('job-x'), deps);

    expect(again).toEqual({ status: 'skipped', detail: 'duplicate' });
    const runs = await store.listReviewRuns(WS, 10);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.jobId === 'job-x')?.status).toBe('failed');
    expect(runs.find((r) => r.id === active.id)?.status).toBe('queued');
  });

  it('skips as `duplicate` on the unconfigured-workspace path too', async () => {
    const store = await createStore();
    await seed(store, false);
    await store.createReviewRun(queuedRetry('retry-z'));
    const { deps } = makeDeps(store);

    const result = await processReviewJob(job('webhook-delivery-z'), deps);

    expect(result).toEqual({ status: 'skipped', detail: 'duplicate' });
    expect(await store.listReviewRuns(WS, 10)).toHaveLength(1);
  });
});
