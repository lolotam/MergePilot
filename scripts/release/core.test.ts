import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CheckRun,
  IMAGE_PATHS,
  decideRelease,
  evaluateChecks,
  isReleaseCommit,
  parseReleaseMessage,
  pinRef,
  producesImage,
  readPin,
  releaseMessage,
  rewritePin,
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

  it('reads the full-SHA tag pin and an optional digest', () => {
    expect(readPin(compose)).toEqual({ ref: `ghcr.io/lolotam/mergepilot:${OLD}`, repository: 'ghcr.io/lolotam/mergepilot', sha: OLD, digest: null });
    const pinned = rewritePin(compose, pinRef('ghcr.io/lolotam/mergepilot', SHA, DIGEST));
    expect(readPin(pinned)).toMatchObject({ sha: SHA, digest: DIGEST });
  });

  it('rewrites only the pin line', () => {
    const out = rewritePin(compose, pinRef('ghcr.io/lolotam/mergepilot', SHA, DIGEST));
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
});

describe('release commits', () => {
  it('round-trips the deployment record in the trailers', () => {
    const t = { sourceCommit: SHA, imageRef: `ghcr.io/a/b:${SHA}@${DIGEST}`, previousSourceCommit: OLD, previousImageRef: `ghcr.io/a/b:${OLD}` };
    const message = releaseMessage(t, false);
    expect(parseReleaseMessage(message)).toEqual(t);
    expect(parseReleaseMessage(releaseMessage({ ...t, previousSourceCommit: null, previousImageRef: null }, true))).toMatchObject({ previousSourceCommit: null });
  });

  it('recognises its own commits so a release never releases itself', () => {
    expect(isReleaseCommit(releaseMessage({ sourceCommit: SHA, imageRef: 'x:y', previousSourceCommit: null, previousImageRef: null }, false))).toBe(true);
    expect(isReleaseCommit('fix(app): something (#131)')).toBe(false);
    expect(parseReleaseMessage('fix(app): something')).toBeNull();
  });
});

describe('rollbackEligible', () => {
  it('allows an image rollback only when no migration changed', () => {
    expect(rollbackEligible(['apps/app/src/x.ts'])).toEqual({ eligible: true, migrations: [] });
    expect(rollbackEligible(['apps/app/migrations/0011_x.sql'])).toEqual({ eligible: false, migrations: ['apps/app/migrations/0011_x.sql'] });
  });
});
