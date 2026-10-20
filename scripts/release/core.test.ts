import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CheckRun,
  IMAGE_PATHS,
  decideRelease,
  evaluateChecks,
  hasWorkerPin,
  isReleaseCommit,
  isWebPhaseCommit,
  parseReleaseMessage,
  pinRef,
  producesImage,
  readPin,
  readWorkerPin,
  releaseMessage,
  rewritePins,
  sameExceptPins,
  rollbackEligible,
} from './core.ts';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const run = (name: string, over: Partial<CheckRun> = {}): CheckRun =>
  ({ id: 1, name, head_sha: SHA, status: 'completed', conclusion: 'success', ...over });
const allGreen = [run('check'), run('integration'), run('Build and Push Docker Image')];
const CODE = ['apps/app/src/x.ts'];

describe('evaluateChecks', () => {
  it('is ready only when every required check of this exact commit succeeded', () => {
    expect(evaluateChecks(SHA, allGreen, CODE)).toEqual({ kind: 'ready' });
  });

  it('ignores green runs that belong to another commit (no borrowing from an earlier SHA)', () => {
    const borrowed = allGreen.map((r) => ({ ...r, head_sha: OLD }));
    expect(evaluateChecks(SHA, borrowed, CODE)).toMatchObject({ kind: 'pending' });
  });

  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', null])(
    'blocks a required check that concluded %s',
    (conclusion) => {
      const runs = [run('check', { conclusion }), run('integration'), run('Build and Push Docker Image')];
      expect(evaluateChecks(SHA, runs, CODE)).toMatchObject({ kind: 'blocked' });
    },
  );

  it('waits while a required check is queued or in progress', () => {
    const runs = [run('check', { status: 'in_progress', conclusion: null }), run('integration'), run('Build and Push Docker Image')];
    expect(evaluateChecks(SHA, runs, CODE)).toEqual({ kind: 'pending', waiting: ['check (in_progress)'] });
  });

  it('treats a missing CI or integration check as pending, never as success', () => {
    expect(evaluateChecks(SHA, [run('check'), run('Build and Push Docker Image')], CODE)).toEqual({
      kind: 'pending',
      waiting: ['integration (not started)'],
    });
  });

  it('waits for a missing image build when the commit changed image files', () => {
    expect(evaluateChecks(SHA, [run('check'), run('integration')], CODE)).toMatchObject({ kind: 'pending' });
  });

  it('skips a docs-only commit that builds no image, but only once CI and integration passed', () => {
    expect(evaluateChecks(SHA, [run('check'), run('integration')], ['docs/deploy.ar.md'])).toMatchObject({ kind: 'no-image' });
    expect(evaluateChecks(SHA, [run('check', { conclusion: 'failure' }), run('integration')], ['README.md'])).toMatchObject({ kind: 'blocked' });
  });

  it('judges a re-run by its latest attempt', () => {
    const runs = [run('check', { id: 1, conclusion: 'failure' }), run('check', { id: 2 }), run('integration'), run('Build and Push Docker Image')];
    expect(evaluateChecks(SHA, runs, CODE)).toEqual({ kind: 'ready' });
    const regressed = [run('check', { id: 2, conclusion: 'failure' }), run('check', { id: 1 }), run('integration'), run('Build and Push Docker Image')];
    expect(evaluateChecks(SHA, regressed, CODE)).toMatchObject({ kind: 'blocked' });
  });
});

describe('producesImage', () => {
  it('matches the paths that make the Docker Image workflow build on main', () => {
    expect(producesImage(['apps/app/src/a.ts'])).toBe(true);
    expect(producesImage(['docker-compose.yml'])).toBe(true);
    expect(producesImage(['pnpm-lock.yaml'])).toBe(true);
    expect(producesImage(['docs/deploy.ar.md', 'README.md', '.github/workflows/ci.yml'])).toBe(false);
  });

  it('keeps IMAGE_PATHS equal to docker.yml on.push.paths', () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/docker.yml'), 'utf8').replace(/\r\n/g, '\n');
    const pushBlock = /\n {2}push:\n([\s\S]*?)\n {2}pull_request:/.exec(workflow)?.[1] ?? '';
    const paths = [...pushBlock.matchAll(/- '([^']+)'/g)].map((m) => m[1]);
    expect(paths).toEqual([...IMAGE_PATHS]);
  });
});

describe('decideRelease', () => {
  const base = { sourceSha: SHA, deployedSha: OLD, onMain: true, sourceIsAncestorOfDeployed: false, deployedIsAncestorOfSource: true };

  it('deploys a newer commit on main', () => {
    expect(decideRelease(base)).toEqual({ kind: 'deploy' });
  });
  it('skips a duplicate event for the deployed commit', () => {
    expect(decideRelease({ ...base, deployedSha: SHA })).toMatchObject({ kind: 'skip' });
  });
  it('skips a stale run whose commit is older than the deployed one', () => {
    expect(decideRelease({ ...base, sourceIsAncestorOfDeployed: true, deployedIsAncestorOfSource: false })).toMatchObject({ kind: 'skip' });
  });
  it('blocks a commit that is not on main (PRs, forks, other branches)', () => {
    expect(decideRelease({ ...base, onMain: false })).toMatchObject({ kind: 'blocked' });
  });
  it('blocks when the deployed commit is not an ancestor (rolled back or rewritten)', () => {
    expect(decideRelease({ ...base, deployedIsAncestorOfSource: false })).toMatchObject({ kind: 'blocked' });
  });
  it('blocks when the deployed commit is unknown', () => {
    expect(decideRelease({ ...base, deployedSha: null })).toMatchObject({ kind: 'blocked' });
  });
});

describe('pins', () => {
  const compose = `# comment\nx-image: &image ghcr.io/lolotam/mergepilot:${OLD}\n\nservices:\n  web:\n    image: *image\n`;
  const workerCompose = `# comment\nx-image: &image ghcr.io/lolotam/mergepilot:${OLD}\nx-worker-image: &worker-image ghcr.io/lolotam/mergepilot:${OLD}\n\nservices:\n  web:\n    image: *image\n  worker:\n    image: *worker-image\n`;

  it('reads the full-SHA tag pin and an optional digest', () => {
    expect(readPin(compose)).toEqual({ ref: `ghcr.io/lolotam/mergepilot:${OLD}`, repository: 'ghcr.io/lolotam/mergepilot', sha: OLD, digest: null });
    const pinned = rewritePins(compose, { image: pinRef('ghcr.io/lolotam/mergepilot', SHA, DIGEST), workerImage: pinRef('ghcr.io/lolotam/mergepilot', SHA, DIGEST) });
    expect(readPin(pinned)).toMatchObject({ sha: SHA, digest: DIGEST });
  });

  it('rewrites only the pin line', () => {
    const out = rewritePins(compose, { image: pinRef('ghcr.io/lolotam/mergepilot', SHA, DIGEST), workerImage: pinRef('ghcr.io/lolotam/mergepilot', SHA, DIGEST) });
    expect(out.replace(/^x-image.*$/m, '')).toBe(compose.replace(/^x-image.*$/m, ''));
  });

  it('refuses a file with zero or two pins, a short SHA or a malformed digest', () => {
    expect(() => readPin('services: {}')).toThrow(/exactly one/);
    expect(() => readPin(`${compose}x-image: &image ghcr.io/a/b:latest\n`)).toThrow(/exactly one/);
    expect(() => pinRef('ghcr.io/a/b', 'abc1234', DIGEST)).toThrow(/full commit SHA/);
    expect(() => pinRef('ghcr.io/a/b', SHA, 'sha256:xyz')).toThrow(/digest/);
  });

  it('does not take a "latest" tag for a commit', () => {
    expect(readPin('x-image: &image ghcr.io/a/b:latest\n').sha).toBeNull();
  });

  it('reads the worker pin of a compose file that has one', () => {
    expect(readWorkerPin(workerCompose)).toEqual({ ref: `ghcr.io/lolotam/mergepilot:${OLD}`, repository: 'ghcr.io/lolotam/mergepilot', sha: OLD, digest: null });
    expect(hasWorkerPin(workerCompose)).toBe(true);
  });

  it('takes the web pin as the worker pin when the file has no worker line', () => {
    expect(readWorkerPin(compose)).toEqual(readPin(compose));
    expect(hasWorkerPin(compose)).toBe(false);
  });

  it('refuses a compose file with two worker pins', () => {
    expect(() => readWorkerPin(`${workerCompose}x-worker-image: &worker-image ghcr.io/a/b:latest\n`)).toThrow(/at most one/);
  });
});

describe('rewritePins', () => {
  const oldCompose = `x-image: &image ghcr.io/lolotam/mergepilot:${OLD}\nservices:\n  web:\n    image: *image\n`;
  const newCompose = `x-image: &image ghcr.io/lolotam/mergepilot:${OLD}\nx-worker-image: &worker-image ghcr.io/lolotam/mergepilot:${OLD}\nservices:\n  web:\n    image: *image\n  worker:\n    image: *worker-image\n`;
  const webRef = `ghcr.io/lolotam/mergepilot:${SHA}`;
  const workerRef = `ghcr.io/lolotam/mergepilot:${OLD}`;

  it('rewrites both pins of a compose file that has a worker line', () => {
    const out = rewritePins(newCompose, { image: webRef, workerImage: workerRef });
    expect(readPin(out).ref).toBe(webRef);
    expect(readWorkerPin(out).ref).toBe(workerRef);
  });

  it('rewrites the web pin only when the file has no worker line and both refs are equal', () => {
    const out = rewritePins(oldCompose, { image: webRef, workerImage: webRef });
    expect(readPin(out).ref).toBe(webRef);
    expect(out).not.toMatch(/x-worker-image/);
  });

  it('refuses to give the worker another image in a file without a worker line', () => {
    expect(() => rewritePins(oldCompose, { image: webRef, workerImage: workerRef })).toThrow(/cannot run another image/);
  });

  it('refuses a compose file without exactly one web pin', () => {
    expect(() => rewritePins('services: {}', { image: webRef, workerImage: webRef })).toThrow(/exactly one/);
    expect(() => rewritePins(`${oldCompose}x-image: &image ghcr.io/a/b:latest\n`, { image: webRef, workerImage: webRef })).toThrow(/exactly one/);
  });
});

describe('sameExceptPins', () => {
  const ref = (sha: string) => `ghcr.io/lolotam/mergepilot:${sha}`;
  const compose = (sha: string) =>
    `x-image: &image ${ref(sha)}\nx-worker-image: &worker-image ${ref(sha)}\nx-app-env: &app-env\n  LOG_LEVEL: info\nservices:\n  web:\n    image: *image\n  worker:\n    image: *worker-image\n    stop_grace_period: 25m\n`;
  const oldCompose = (sha: string) => `x-image: &image ${ref(sha)}\nx-app-env: &app-env\n  LOG_LEVEL: info\nservices:\n  web:\n    image: *image\n`;

  it('is true when only the pin values differ', () => {
    expect(sameExceptPins(compose(OLD), compose(SHA))).toBe(true);
    expect(sameExceptPins(oldCompose(OLD), oldCompose(SHA))).toBe(true);
  });

  it('is true for the same file with CRLF and LF line endings', () => {
    expect(sameExceptPins(compose(OLD).replace(/\n/g, '\r\n'), compose(SHA))).toBe(true);
  });

  it('is false when any other line differs', () => {
    expect(sameExceptPins(compose(OLD), compose(SHA).replace('LOG_LEVEL: info', 'LOG_LEVEL: debug'))).toBe(false);
    expect(sameExceptPins(compose(OLD), compose(SHA).replace('stop_grace_period: 25m', 'stop_grace_period: 10s'))).toBe(false);
  });

  it('is false when one file has a worker line and the other has not', () => {
    expect(sameExceptPins(compose(OLD), oldCompose(SHA))).toBe(false);
  });
});

describe('release commits', () => {
  const trailers = {
    sourceCommit: SHA,
    imageRef: `ghcr.io/a/b:${SHA}@${DIGEST}`,
    workerSourceCommit: OLD,
    workerImageRef: `ghcr.io/a/b:${OLD}`,
    previousSourceCommit: OLD,
    previousImageRef: `ghcr.io/a/b:${OLD}`,
    previousWorkerSourceCommit: OLD,
    previousWorkerImageRef: `ghcr.io/a/b:${OLD}`,
  };

  it('round-trips the deployment record in the trailers', () => {
    const message = releaseMessage(trailers, 'release');
    expect(parseReleaseMessage(message)).toEqual(trailers);
    expect(parseReleaseMessage(releaseMessage({ ...trailers, previousSourceCommit: null, previousImageRef: null }, 'release'))).toMatchObject({ previousSourceCommit: null });
  });

  it('names the phase in the subject and keeps the release prefix', () => {
    expect(releaseMessage(trailers, 'release').split('\n')[0]).toBe(`chore(release): deploy ${SHA.slice(0, 7)}`);
    expect(releaseMessage(trailers, 'web').split('\n')[0]).toBe(`chore(release): deploy ${SHA.slice(0, 7)} (web first)`);
    expect(releaseMessage(trailers, 'rollback').split('\n')[0]).toBe(`chore(release): deploy ${SHA.slice(0, 7)} (rollback)`);
    for (const kind of ['release', 'web', 'rollback'] as const) {
      expect(releaseMessage(trailers, kind).startsWith('chore(release): deploy ')).toBe(true);
    }
  });

  it('writes the worker trailers next to the web ones', () => {
    const message = releaseMessage(trailers, 'web');
    expect(message).toContain(`Worker-Source-Commit: ${OLD}`);
    expect(message).toContain(`Worker-Image-Ref: ${trailers.workerImageRef}`);
    expect(message).toContain(`Previous-Worker-Source-Commit: ${OLD}`);
    expect(message).toContain(`Previous-Worker-Image-Ref: ${trailers.previousWorkerImageRef}`);
    expect(releaseMessage({ ...trailers, workerSourceCommit: null, previousWorkerSourceCommit: null }, 'release')).toContain('Worker-Source-Commit: none');
  });

  it('keeps a worker commit recorded as none instead of taking the web commit', () => {
    const message = releaseMessage({ ...trailers, workerSourceCommit: null, previousWorkerSourceCommit: null }, 'web');
    expect(parseReleaseMessage(message)).toMatchObject({ workerSourceCommit: null, previousWorkerSourceCommit: null });
  });

  it('reads a message without worker trailers as a release where the worker runs the web image', () => {
    const legacy = [
      `chore(release): deploy ${SHA.slice(0, 7)}`,
      '',
      `Source-Commit: ${SHA}`,
      `Image-Ref: ${trailers.imageRef}`,
      `Previous-Source-Commit: ${OLD}`,
      `Previous-Image-Ref: ${trailers.previousImageRef}`,
    ].join('\n');
    expect(parseReleaseMessage(legacy)).toEqual({
      sourceCommit: SHA,
      imageRef: trailers.imageRef,
      workerSourceCommit: SHA,
      workerImageRef: trailers.imageRef,
      previousSourceCommit: OLD,
      previousImageRef: trailers.previousImageRef,
      previousWorkerSourceCommit: OLD,
      previousWorkerImageRef: trailers.previousImageRef,
    });
  });

  it('recognises its own commits so a release never releases itself', () => {
    expect(isReleaseCommit(releaseMessage(trailers, 'release'))).toBe(true);
    expect(isReleaseCommit('fix(app): something (#131)')).toBe(false);
    expect(parseReleaseMessage('fix(app): something')).toBeNull();
  });

  it('tells a web-phase commit from a full release and from a rollback', () => {
    expect(isWebPhaseCommit(releaseMessage(trailers, 'web'))).toBe(true);
    expect(isWebPhaseCommit(releaseMessage(trailers, 'release'))).toBe(false);
    expect(isWebPhaseCommit(releaseMessage(trailers, 'rollback'))).toBe(false);
    expect(isWebPhaseCommit('fix(app): something (#131)')).toBe(false);
  });
});

describe('rollbackEligible', () => {
  it('allows an image rollback only when no migration changed', () => {
    expect(rollbackEligible(['apps/app/src/x.ts'])).toEqual({ eligible: true, migrations: [] });
    expect(rollbackEligible(['apps/app/migrations/0011_x.sql'])).toEqual({ eligible: false, migrations: ['apps/app/migrations/0011_x.sql'] });
  });
});
