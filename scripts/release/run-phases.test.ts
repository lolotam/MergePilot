import { describe, expect, it, vi } from 'vitest';
import { type CheckRun, parseReleaseMessage, releaseMessage } from './core.ts';
import { type DokployPort, type GitHubPort, type ReleaseConfig, type ReleasePorts, runRelease } from './run.ts';
import type { Clock, ContainerSnapshot } from './verify.ts';

const NEW = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const MID = 'c'.repeat(40);
const REPO = 'ghcr.io/lolotam/mergepilot';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const OLD_REF = `${REPO}:${OLD}`;
const MID_REF = `${REPO}:${MID}`;
const NEW_REF = `${REPO}:${NEW}@${DIGEST}`;

/** A compose file with the worker pin: the two-phase release (ADR-0025 amendment). */
const compose = (ref: string) => `x-image: &image ${ref}\nx-worker-image: &worker-image ${ref}\nservices:\n  web:\n    image: *image\n  worker:\n    image: *worker-image\n`;
/** A compose file without the worker pin: older than the amendment, released in one phase. */
const oldCompose = (ref: string) => `x-image: &image ${ref}\nservices:\n  web:\n    image: *image\n`;

const green = (sha: string): CheckRun[] =>
  ['check', 'integration', 'Build and Push Docker Image'].map((name, i) => ({ id: i + 1, name, head_sha: sha, status: 'completed', conclusion: 'success' }));

/** Fake clock: sleeping advances time instantly so timeouts are tested without waiting. */
function fakeClock(): Clock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

/** What runs in production: the web image and the worker image, each with its commit. */
interface Running {
  web: string;
  webSha: string;
  worker: string;
  workerSha: string;
}

const healthy = (running: Running): ContainerSnapshot[] => [
  { service: 'migrate', image: running.web, revision: running.webSha, state: 'exited', exitCode: 0, health: null },
  { service: 'postgres', image: 'postgres:17-alpine', revision: null, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'redis', image: 'redis:7-alpine', revision: null, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'web', image: running.web, revision: running.webSha, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'worker', image: running.worker, revision: running.workerSha, state: 'running', exitCode: 0, health: 'healthy' },
];

interface Options {
  /** Whether the compose file of the candidate pins the worker apart from the web. */
  workerPin?: boolean;
  /** The release branch head before the run. */
  head?: { sha: string; message: string };
  /** The service that must fail its health check once it runs the new image. */
  fail?: 'web' | 'worker';
  /** A line the candidate's compose file changed beyond the image pins. */
  changedLine?: string;
}

function setup(opts: Options = {}) {
  const workerPin = opts.workerPin ?? true;
  const branch = {
    head:
      opts.head ?? {
        sha: 'r0',
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
  // What runs today is what the release branch head names.
  const head = parseReleaseMessage(branch.head.message);
  const running: Running = {
    web: head?.imageRef ?? OLD_REF,
    webSha: head?.sourceCommit ?? OLD,
    worker: head?.workerImageRef ?? OLD_REF,
    workerSha: head?.workerSourceCommit ?? OLD,
  };
  const commits: { parentSha: string; content: string; message: string }[] = [];
  const deployments: { title: string; web: string; worker: string }[] = [];
  const deployed: string[] = [];
  const logs: string[] = [];

  const github: GitHubPort = {
    commitMessage: vi.fn(async () => 'feat: something (#132)'),
    commitFiles: vi.fn(async () => ['apps/app/src/x.ts']),
    changedMigrations: vi.fn(async () => []),
    checkRuns: vi.fn(async (sha: string) => green(sha)),
    // History: OLD -> NEW on main.
    isAncestor: vi.fn(async (a: string, b: string) => a === b || (a === OLD && (b === NEW || b === 'main')) || (a === NEW && b === 'main')),
    branchHead: vi.fn(async () => branch.head),
    // The compose file of a ref: the candidate's own file, or the file of what runs now (the
    // deployed one), which is the same file with the pins of the running release.
    fileAt: vi.fn(async (ref: string) => {
      const file = workerPin ? compose(`${REPO}:${ref}`) : oldCompose(`${REPO}:${ref}`);
      return ref === NEW && opts.changedLine ? `${file}${opts.changedLine}\n` : file;
    }),
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

  const dokploy: DokployPort = {
    deploymentIds: vi.fn(async () => new Set(deployed)),
    deploy: vi.fn(async (title: string) => {
      const trailers = parseReleaseMessage(branch.head?.message ?? '');
      running.web = trailers?.imageRef ?? running.web;
      running.webSha = trailers?.sourceCommit ?? running.webSha;
      running.worker = trailers?.workerImageRef ?? running.worker;
      running.workerSha = trailers?.workerSourceCommit ?? running.workerSha;
      deployed.push(`d${deployed.length + 1}`);
      deployments.push({ title, web: running.web, worker: running.worker });
    }),
    newDeployment: vi.fn(async (before: Set<string>) => {
      const id = deployed.find((d) => !before.has(d));
      return id ? { id, status: 'done' } : undefined;
    }),
    containers: vi.fn(async () => {
      const snapshots = healthy(running);
      if (opts.fail === 'web' && running.web === NEW_REF) {
        return snapshots.map((c) => (c.service === 'web' ? { ...c, health: 'unhealthy' } : c));
      }
      if (opts.fail === 'worker' && running.worker === NEW_REF) {
        return snapshots.map((c) => (c.service === 'worker' ? { ...c, health: 'unhealthy' } : c));
      }
      return snapshots;
    }),
  };

  const ports: ReleasePorts = {
    github,
    registry: { resolve: vi.fn(async (_repo: string, sha: string) => ({ digest: DIGEST, revision: sha })) },
    dokploy,
    health: vi.fn(async () => ({ status: 200, body: '{"ok":true}' })),
    log: (line: string) => {
      logs.push(line);
    },
    clock: fakeClock(),
  };
  const cfg: ReleaseConfig = { sha: NEW, live: true, repository: 'lolotam/MergePilot', releaseBranch: 'production', composePath: 'deploy/docker-compose.dokploy.yml', deployTimeoutMs: 35 * 60_000, verifyTimeoutMs: 10 * 60_000, intervalMs: 15_000 };
  return { cfg, ports, github, dokploy, commits, deployments, logs };
}

describe('the two-phase release', () => {
  it('deploys the web first and the worker after, in two release commits', async () => {
    const { cfg, ports, commits, deployments } = setup();
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'deployed' });
    expect(commits).toHaveLength(2);
    expect(commits[0]?.message.split('\n')[0]).toBe(`chore(release): deploy ${NEW.slice(0, 7)} (web first)`);
    expect(commits[1]?.message.split('\n')[0]).toBe(`chore(release): deploy ${NEW.slice(0, 7)}`);
    // The web-phase commit keeps the worker on the image it runs today.
    expect(commits[0]?.content).toContain(`x-image: &image ${NEW_REF}`);
    expect(commits[0]?.content).toContain(`x-worker-image: &worker-image ${OLD_REF}`);
    expect(commits[1]?.content).toContain(`x-worker-image: &worker-image ${NEW_REF}`);
    // The trailers name the worker of the phase they belong to.
    expect(parseReleaseMessage(commits[0]?.message ?? '')).toMatchObject({ workerSourceCommit: OLD, workerImageRef: OLD_REF });
    expect(parseReleaseMessage(commits[1]?.message ?? '')).toMatchObject({ workerSourceCommit: NEW, workerImageRef: NEW_REF });
    // Two deploys: the first leaves the worker alone, the second moves it too.
    expect(deployments).toEqual([
      { title: `release ${NEW.slice(0, 7)} (web first)`, web: NEW_REF, worker: OLD_REF },
      { title: `release ${NEW.slice(0, 7)} (worker)`, web: NEW_REF, worker: NEW_REF },
    ]);
  });

  it('rolls both images back to the previous release when the web phase fails', async () => {
    const { cfg, ports, commits, deployments } = setup({ fail: 'web' });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'rolled-back', hold: 77 });
    expect(commits).toHaveLength(2);
    expect(commits[1]?.message.split('\n')[0]).toBe(`chore(release): deploy ${OLD.slice(0, 7)} (rollback)`);
    expect(commits[1]?.content).toContain(`x-image: &image ${OLD_REF}`);
    expect(commits[1]?.content).toContain(`x-worker-image: &worker-image ${OLD_REF}`);
    expect(deployments[1]).toEqual({ title: `rollback to ${OLD.slice(0, 7)}`, web: OLD_REF, worker: OLD_REF });
  });

  it('rolls back when the worker phase fails', async () => {
    const { cfg, ports, commits, deployments } = setup({ fail: 'worker' });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'rolled-back', hold: 77 });
    expect(commits).toHaveLength(3);
    expect(commits[2]?.content).toContain(`x-image: &image ${OLD_REF}`);
    expect(commits[2]?.content).toContain(`x-worker-image: &worker-image ${OLD_REF}`);
    expect(deployments.map((d) => d.worker)).toEqual([OLD_REF, NEW_REF, OLD_REF]);
  });

  it('resumes an incomplete record of the same commit with the web phase again and then the worker phase', async () => {
    const webPhase = releaseMessage(
      {
        sourceCommit: NEW,
        imageRef: NEW_REF,
        workerSourceCommit: OLD,
        workerImageRef: OLD_REF,
        previousSourceCommit: OLD,
        previousImageRef: OLD_REF,
        previousWorkerSourceCommit: OLD,
        previousWorkerImageRef: OLD_REF,
      },
      'web',
    );
    const { cfg, ports, commits, deployments } = setup({ head: { sha: 'r1', message: webPhase } });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'deployed' });
    // One new commit only: the worker phase. The web phase is deployed again, not written again.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message.split('\n')[0]).toBe(`chore(release): deploy ${NEW.slice(0, 7)}`);
    expect(commits[0]?.content).toContain(`x-worker-image: &worker-image ${NEW_REF}`);
    // Two deploys: the recorded web phase again (the worker stays on the old image), then the worker.
    expect(deployments).toEqual([
      { title: `release ${NEW.slice(0, 7)} (web first, resumed)`, web: NEW_REF, worker: OLD_REF },
      { title: `release ${NEW.slice(0, 7)} (worker)`, web: NEW_REF, worker: NEW_REF },
    ]);
  });

  it('rolls back to the recorded previous release when the resumed web phase fails to verify', async () => {
    const webPhase = releaseMessage(
      {
        sourceCommit: NEW,
        imageRef: NEW_REF,
        workerSourceCommit: OLD,
        workerImageRef: OLD_REF,
        previousSourceCommit: OLD,
        previousImageRef: OLD_REF,
        previousWorkerSourceCommit: OLD,
        previousWorkerImageRef: OLD_REF,
      },
      'web',
    );
    const { cfg, ports, commits, deployments, github } = setup({ head: { sha: 'r1', message: webPhase }, fail: 'web' });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'rolled-back', hold: 77 });
    // The rollback commit is the only one: the worker phase never runs.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message.split('\n')[0]).toBe(`chore(release): deploy ${OLD.slice(0, 7)} (rollback)`);
    expect(commits[0]?.content).toContain(`x-image: &image ${OLD_REF}`);
    expect(commits[0]?.content).toContain(`x-worker-image: &worker-image ${OLD_REF}`);
    expect(deployments[1]).toEqual({ title: `rollback to ${OLD.slice(0, 7)}`, web: OLD_REF, worker: OLD_REF });
    expect(github.openHold).toHaveBeenCalledTimes(1);
  });

  it('skips a split rollback record of the same commit as already deployed', async () => {
    const rollback = releaseMessage(
      {
        sourceCommit: NEW,
        imageRef: NEW_REF,
        workerSourceCommit: OLD,
        workerImageRef: OLD_REF,
        previousSourceCommit: NEW,
        previousImageRef: NEW_REF,
        previousWorkerSourceCommit: OLD,
        previousWorkerImageRef: OLD_REF,
      },
      'rollback',
    );
    const { cfg, ports, commits, deployments } = setup({ head: { sha: 'r1', message: rollback } });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'skipped', detail: expect.stringContaining('already deployed') });
    expect(commits).toHaveLength(0);
    expect(deployments).toHaveLength(0);
  });

  it('rolls a newer candidate back to the pair a split rollback record runs', async () => {
    const rollback = releaseMessage(
      {
        sourceCommit: OLD,
        imageRef: MID_REF,
        workerSourceCommit: OLD,
        workerImageRef: OLD_REF,
        previousSourceCommit: NEW,
        previousImageRef: NEW_REF,
        previousWorkerSourceCommit: NEW,
        previousWorkerImageRef: NEW_REF,
      },
      'rollback',
    );
    const { cfg, ports, commits, deployments } = setup({ head: { sha: 'r1', message: rollback }, fail: 'web' });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'rolled-back', hold: 77 });
    // The web phase leaves the worker on the image the record runs.
    expect(commits[0]?.message.split('\n')[0]).toBe(`chore(release): deploy ${NEW.slice(0, 7)} (web first)`);
    expect(commits[0]?.content).toContain(`x-image: &image ${NEW_REF}`);
    expect(commits[0]?.content).toContain(`x-worker-image: &worker-image ${OLD_REF}`);
    // The rollback returns to the record's own pair, not to the failed release its trailers name.
    expect(commits[1]?.message.split('\n')[0]).toBe(`chore(release): deploy ${OLD.slice(0, 7)} (rollback)`);
    expect(commits[1]?.content).toContain(`x-image: &image ${MID_REF}`);
    expect(commits[1]?.content).toContain(`x-worker-image: &worker-image ${OLD_REF}`);
    expect(deployments[1]).toEqual({ title: `rollback to ${OLD.slice(0, 7)}`, web: MID_REF, worker: OLD_REF });
  });

  it('releases a compose file without a worker pin in one phase', async () => {
    const { cfg, ports, commits, deployments } = setup({ workerPin: false });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'deployed' });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.content).not.toMatch(/x-worker-image/);
    expect(deployments).toEqual([{ title: `release ${NEW.slice(0, 7)}`, web: NEW_REF, worker: NEW_REF }]);
  });

  it('releases in one phase when the compose file changed beyond the image pins', async () => {
    const { cfg, ports, commits, deployments, logs } = setup({ changedLine: '    stop_grace_period: 25m' });
    const outcome = await runRelease(cfg, ports);
    expect(outcome).toMatchObject({ kind: 'deployed' });
    // One release commit and one deploy: the change may recreate the worker, so the site waits
    // for its drain instead of running the web phase.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.content).toContain('stop_grace_period: 25m');
    expect(commits[0]?.content).toContain(`x-worker-image: &worker-image ${NEW_REF}`);
    expect(deployments).toEqual([{ title: `release ${NEW.slice(0, 7)}`, web: NEW_REF, worker: NEW_REF }]);
    expect(logs).toContain('plan: the compose file changed beyond the image pins, so this release runs in one phase (the site waits for the worker drain)');
  });

  it('dry run plans both phases and changes nothing', async () => {
    const { cfg, ports, github, dokploy } = setup();
    const outcome = await runRelease({ ...cfg, live: false }, ports);
    expect(outcome).toMatchObject({ kind: 'planned', detail: expect.stringContaining('web first') });
    expect(github.writeReleaseCommit).not.toHaveBeenCalled();
    expect(dokploy.deploy).not.toHaveBeenCalled();
  });
});
