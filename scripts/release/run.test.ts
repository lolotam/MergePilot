import { describe, expect, it, vi } from 'vitest';
import { type CheckRun, parseReleaseMessage, releaseMessage } from './core.ts';
import { type DokployPort, type GitHubPort, type ReleaseConfig, type ReleasePorts, assertFitsJob, exitCodeOf, runRelease } from './run.ts';
import type { Clock, ContainerSnapshot } from './verify.ts';

const NEW = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const REPO = 'ghcr.io/lolotam/mergepilot';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const OLD_REF = `${REPO}:${OLD}`;
const NEW_REF = `${REPO}:${NEW}@${DIGEST}`;
// A compose file without a worker pin: older than the ADR-0025 amendment, released in one phase.
const compose = (ref: string) => `x-image: &image ${ref}\nservices:\n  web:\n    image: *image\n`;
const green = (sha: string): CheckRun[] =>
  ['check', 'integration', 'Build and Push Docker Image'].map((name, i) => ({ id: i + 1, name, head_sha: sha, status: 'completed', conclusion: 'success' }));

/** Fake clock: sleeping advances time instantly so timeouts are tested without waiting. */
function fakeClock(): Clock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const healthy = (ref: string, sha: string): ContainerSnapshot[] => [
  { service: 'migrate', image: ref, revision: sha, state: 'exited', exitCode: 0, health: null },
  { service: 'postgres', image: 'postgres:17-alpine', revision: null, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'redis', image: 'redis:7-alpine', revision: null, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'web', image: ref, revision: sha, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'worker', image: ref, revision: sha, state: 'running', exitCode: 0, health: 'healthy' },
];

function setup(opts: { releaseBranch?: boolean; deploymentStatus?: string; containers?: (ref: string) => ContainerSnapshot[]; migrations?: string[] } = {}) {
  const branch = {
    head:
      opts.releaseBranch === false
        ? null
        : {
            sha: 'r1',
            message: releaseMessage(
              {
                sourceCommit: OLD,
                imageRef: OLD_REF,
                workerSourceCommit: OLD,
                workerImageRef: OLD_REF,
                previousSourceCommit: null,
                previousImageRef: null,
                previousWorkerSourceCommit: null,
                previousWorkerImageRef: null,
              },
              'release',
            ),
          },
  };
  const commits: { parentSha: string; content: string; message: string }[] = [];
  const github: GitHubPort = {
    commitMessage: vi.fn(async () => 'feat: something (#132)'),
    commitFiles: vi.fn(async () => ['apps/app/src/x.ts']),
    changedMigrations: vi.fn(async () => opts.migrations ?? []),
    checkRuns: vi.fn(async (sha: string) => green(sha)),
    // History: OLD -> NEW on main.
    isAncestor: vi.fn(async (a: string, b: string) => a === b || (a === OLD && (b === NEW || b === 'main')) || (a === NEW && b === 'main')),
    branchHead: vi.fn(async () => branch.head),
    fileAt: vi.fn(async (ref: string) => compose(ref === 'main' ? OLD_REF : `${REPO}:${ref}`)),
    openHolds: vi.fn(async () => []),
    openHold: vi.fn(async () => 77),
    writeReleaseCommit: vi.fn(async (input) => {
      if ((branch.head?.sha ?? null) !== input.expectedHead) throw new Error('branch moved');
      commits.push(input);
      const sha = `r${commits.length + 2}`;
      branch.head = { sha, message: input.message };
      return sha;
    }),
  };
  let running = OLD_REF;
  let runningSha = OLD;
  const deployed: string[] = [];
  const dokploy: DokployPort = {
    deploymentIds: vi.fn(async () => new Set(deployed)),
    deploy: vi.fn(async () => {
      const trailers = parseReleaseMessage(branch.head?.message ?? '');
      running = trailers?.imageRef ?? running;
      runningSha = trailers?.sourceCommit ?? runningSha;
      deployed.push(`d${deployed.length + 1}`);
    }),
    newDeployment: vi.fn(async (before: Set<string>) => {
      const id = deployed.find((d) => !before.has(d));
      return id ? { id, status: opts.deploymentStatus ?? 'done' } : undefined;
    }),
    containers: vi.fn(async () => (opts.containers ?? ((ref) => healthy(ref, runningSha)))(running)),
  };
  const ports: ReleasePorts = {
    github,
    registry: { resolve: vi.fn(async (_repo: string, sha: string) => ({ digest: DIGEST, revision: sha })) },
    dokploy,
    health: vi.fn(async () => ({ status: 200, body: '{"ok":true}' })),
    log: () => undefined,
    clock: fakeClock(),
  };
  const cfg: ReleaseConfig = { sha: NEW, live: true, repository: 'lolotam/MergePilot', releaseBranch: 'production', composePath: 'deploy/docker-compose.dokploy.yml', deployTimeoutMs: 35 * 60_000, verifyTimeoutMs: 10 * 60_000, intervalMs: 15_000 };
  return { cfg, ports, github, dokploy, commits, branch };
}

describe('runRelease gates', () => {
  it('dry run plans the digest pin and changes nothing', async () => {
    const { cfg, ports, github, dokploy } = setup();
    const outcome = await runRelease({ ...cfg, live: false }, ports);
    expect(outcome).toEqual({ kind: 'planned', detail: `would deploy ${NEW_REF} over ${OLD_REF}` });
    expect(github.writeReleaseCommit).not.toHaveBeenCalled();
    expect(dokploy.deploy).not.toHaveBeenCalled();
  });

  it('dry run before the release branch exists reads what main pins (what Dokploy runs today)', async () => {
    const { cfg, ports } = setup({ releaseBranch: false });
    expect(await runRelease({ ...cfg, live: false }, ports)).toMatchObject({ kind: 'planned' });
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'blocked', detail: expect.stringContaining('bootstrap') });
  });

  it('never releases a release commit (loop guard)', async () => {
    const { cfg, ports, github } = setup();
    vi.mocked(github.commitMessage).mockResolvedValue(
      releaseMessage(
        { sourceCommit: NEW, imageRef: NEW_REF, workerSourceCommit: NEW, workerImageRef: NEW_REF, previousSourceCommit: null, previousImageRef: null, previousWorkerSourceCommit: null, previousWorkerImageRef: null },
        'release',
      ),
    );
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'skipped' });
    expect(github.checkRuns).not.toHaveBeenCalled();
  });

  it('stops every release while a release-hold issue is open', async () => {
    const { cfg, ports, github } = setup();
    vi.mocked(github.openHolds).mockResolvedValue([77]);
    expect(await runRelease(cfg, ports)).toEqual({ kind: 'blocked', detail: 'release hold open: #77' });
  });

  it('blocks a commit that is not on main before reading any check (PR head, fork, other branch)', async () => {
    const { cfg, ports, github, dokploy } = setup();
    const stray = 'c'.repeat(40);
    expect(await runRelease({ ...cfg, sha: stray }, ports)).toEqual({ kind: 'blocked', detail: `${stray} is not on main` });
    expect(github.checkRuns).not.toHaveBeenCalled();
    expect(dokploy.deploy).not.toHaveBeenCalled();
  });

  it('waits on pending checks and blocks on failed ones, without deploying', async () => {
    const { cfg, ports, github, dokploy } = setup();
    vi.mocked(github.checkRuns).mockResolvedValueOnce(green(NEW).slice(0, 2));
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'waiting' });
    vi.mocked(github.checkRuns).mockResolvedValueOnce(green(NEW).map((r) => (r.name === 'integration' ? { ...r, conclusion: 'cancelled' } : r)));
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'blocked' });
    expect(dokploy.deploy).not.toHaveBeenCalled();
  });

  it('refuses checks that passed for another commit (SHA mismatch)', async () => {
    const { cfg, ports, github } = setup();
    vi.mocked(github.checkRuns).mockResolvedValue(green(OLD));
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'waiting' });
  });

  it('skips docs-only commits and duplicate or stale events idempotently', async () => {
    const docs = setup();
    vi.mocked(docs.github.commitFiles).mockResolvedValue(['docs/deploy.ar.md']);
    vi.mocked(docs.github.checkRuns).mockResolvedValue(green(NEW).slice(0, 2));
    expect(await runRelease(docs.cfg, docs.ports)).toMatchObject({ kind: 'skipped' });

    const dup = setup();
    expect(await runRelease({ ...dup.cfg, sha: OLD }, dup.ports)).toMatchObject({ kind: 'skipped', detail: expect.stringContaining('already deployed') });
    expect(dup.github.writeReleaseCommit).not.toHaveBeenCalled();
  });

  it('blocks an image whose revision label is not the candidate commit', async () => {
    const { cfg, ports, dokploy } = setup();
    vi.mocked(ports.registry.resolve).mockResolvedValue({ digest: DIGEST, revision: OLD });
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'blocked', detail: expect.stringContaining('revision') });
    expect(dokploy.deploy).not.toHaveBeenCalled();
  });

  it('live mode without Dokploy credentials changes nothing', async () => {
    const { cfg, ports, github } = setup();
    expect(await runRelease(cfg, { ...ports, dokploy: null })).toMatchObject({ kind: 'blocked' });
    expect(github.writeReleaseCommit).not.toHaveBeenCalled();
  });
});

describe('runRelease deploy, verification and rollback', () => {
  it('commits the digest pin on top of the candidate, deploys once and verifies identity', async () => {
    const { cfg, ports, commits, dokploy } = setup();
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'deployed' });
    expect(exitCodeOf(outcome)).toBe(0);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ parentSha: NEW, content: compose(NEW_REF) });
    expect(parseReleaseMessage(commits[0]?.message ?? '')).toEqual({
      sourceCommit: NEW,
      imageRef: NEW_REF,
      workerSourceCommit: NEW,
      workerImageRef: NEW_REF,
      previousSourceCommit: OLD,
      previousImageRef: OLD_REF,
      previousWorkerSourceCommit: OLD,
      previousWorkerImageRef: OLD_REF,
    });
    expect(dokploy.deploy).toHaveBeenCalledTimes(1);
  });

  it('a duplicate event after a release is a no-op', async () => {
    const { cfg, ports, dokploy } = setup();
    await runRelease(cfg, ports);
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'skipped' });
    expect(dokploy.deploy).toHaveBeenCalledTimes(1);
  });

  it('refuses to move the release branch when another release moved it first', async () => {
    const { cfg, ports, branch, dokploy, github } = setup();
    const write = github.writeReleaseCommit;
    const raced: GitHubPort = {
      ...github,
      writeReleaseCommit: async (input) => {
        branch.head = { sha: 'other-release', message: branch.head?.message ?? '' };
        return write(input);
      },
    };
    await expect(runRelease(cfg, { ...ports, github: raced })).rejects.toThrow(/branch moved/);
    expect(dokploy.deploy).not.toHaveBeenCalled();
  });

  it('rolls back the image when verification fails and no migration changed, then holds releases', async () => {
    const { cfg, ports, commits, dokploy, github } = setup({
      containers: (ref) => (ref === NEW_REF ? healthy(ref, NEW).map((c) => (c.service === 'worker' ? { ...c, health: 'unhealthy' } : c)) : healthy(ref, OLD)),
    });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'rolled-back', hold: 77 });
    expect(exitCodeOf(outcome)).toBe(1);
    expect(commits).toHaveLength(2);
    expect(commits[1]).toMatchObject({ parentSha: OLD, content: compose(OLD_REF) });
    expect(dokploy.deploy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(github.openHold).mock.calls[0]?.[1]).toContain('worker health is unhealthy');
  });

  it('does not roll back across a migration and asks for a person instead', async () => {
    const { cfg, ports, commits, dokploy, github } = setup({ deploymentStatus: 'error', migrations: ['apps/app/migrations/0011_x.sql'] });
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'failed', hold: 77 });
    expect(commits).toHaveLength(1);
    expect(dokploy.deploy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(github.openHold).mock.calls[0]?.[1]).toContain('migrations changed');
  });

  it('times out a deployment that never finishes, treats it as failed and holds releases', async () => {
    const { cfg, ports, dokploy, github } = setup();
    vi.mocked(dokploy.newDeployment).mockResolvedValue({ id: 'd1', status: 'running' });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'failed', hold: 77, detail: expect.stringContaining('timed out after 2100s') });
    expect(github.openHold).toHaveBeenCalledTimes(1);
  });

  it('a refused deploy call after the release commit still rolls the record back and holds releases', async () => {
    const { cfg, ports, dokploy, github, branch } = setup();
    vi.mocked(dokploy.deploy).mockRejectedValueOnce(new Error('Dokploy compose.deploy answered HTTP 401'));
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'rolled-back', hold: 77, detail: expect.stringContaining('HTTP 401') });
    expect(parseReleaseMessage(branch.head?.message ?? '')?.sourceCommit).toBe(OLD);
    expect(github.openHold).toHaveBeenCalledTimes(1);
  });

  it('still opens the hold when the rollback itself errors (migration check or rollback commit)', async () => {
    const broken = (ref: string) => (ref === NEW_REF ? healthy(ref, NEW).map((c) => (c.service === 'web' ? { ...c, health: 'unhealthy' } : c)) : healthy(ref, OLD));

    const lookup = setup({ containers: broken });
    vi.mocked(lookup.github.changedMigrations).mockRejectedValue(new Error('compare answered HTTP 502'));
    expect(await runRelease(lookup.cfg, lookup.ports)).toMatchObject({ kind: 'failed', hold: 77, detail: expect.stringContaining('rollback aborted: compare answered HTTP 502') });

    const write = setup({ containers: broken });
    const first = write.github.writeReleaseCommit;
    let calls = 0;
    write.github.writeReleaseCommit = vi.fn(async (input) => (++calls === 1 ? first(input) : Promise.reject(new Error('production moved'))));
    expect(await runRelease(write.cfg, write.ports)).toMatchObject({ kind: 'failed', hold: 77, detail: expect.stringContaining('rollback aborted: production moved') });
    expect(vi.mocked(write.github.openHold).mock.calls[0]?.[1]).toContain('Automatic rollback ABORTED');
  });

  it('a failure to open the hold is reported as such, not as a rollback error, and opened once', async () => {
    const { cfg, ports, github } = setup({ deploymentStatus: 'error', migrations: ['apps/app/migrations/0011_x.sql'] });
    vi.mocked(github.openHold).mockRejectedValue(new Error('open release hold answered HTTP 502'));
    await expect(runRelease(cfg, ports)).rejects.toThrow('open release hold answered HTTP 502');
    expect(github.openHold).toHaveBeenCalledTimes(1);
    expect(vi.mocked(github.openHold).mock.calls[0]?.[1]).not.toContain('ABORTED');
  });

  it('fails verification on a wrong public health answer even if containers look right', async () => {
    const { cfg, ports } = setup();
    vi.mocked(ports.health).mockResolvedValue({ status: 502, body: 'Bad Gateway' });
    expect(await runRelease(cfg, ports)).toMatchObject({ kind: 'failed' });
  });
});

describe('assertFitsJob', () => {
  const min = 60_000;
  it('accepts the default timeouts in the 180-minute job: 3 x (35 + 10) + 20 = 170 min', () => {
    expect(() => assertFitsJob({ deployTimeoutMs: 35 * min, verifyTimeoutMs: 10 * min }, 180 * min)).not.toThrow();
  });

  it('refuses timeouts whose two phases plus a rollback could outlast the job', () => {
    expect(() => assertFitsJob({ deployTimeoutMs: 35 * min, verifyTimeoutMs: 10 * min }, 120 * min)).toThrow(/need up to 155 min .* allows 120 min/);
    expect(() => assertFitsJob({ deployTimeoutMs: 50 * min, verifyTimeoutMs: 10 * min }, 180 * min)).toThrow(/200 min/);
  });
});
