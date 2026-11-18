import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CHECKS } from '../release/core.ts';
import { assertSuccessfulNeeds } from './gate.ts';
import { assertCompleteShards } from './inventory.ts';

const root = resolve(import.meta.dirname, '../..');
// Reuse the engine's declared YAML dependency; no new root dependency or lockfile change.
const { parse } = createRequire(resolve(root, 'packages/engine/package.json'))('yaml') as {
  parse: (source: string) => Workflow;
};
interface Step {
  name?: string;
  uses?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
}
interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  'runs-on': string;
  'timeout-minutes': number;
  strategy?: { 'fail-fast': boolean; 'max-parallel': number; matrix: { shard: number[] } };
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<'static' | 'unit' | 'check', Job>;
}
const source = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const workflow = parse(source);
const jobs = workflow.jobs;
const good = { static: { result: 'success' }, unit: { result: 'success' } };

describe('CI final gate', () => {
  it('accepts only complete successful dependency outcomes', () => {
    expect(() => assertSuccessfulNeeds(good)).not.toThrow();
  });

  for (const job of ['static', 'unit']) {
    it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', '', null, undefined])(
      `refuses ${job} result %s`, (result) => {
        expect(() => assertSuccessfulNeeds({ ...good, [job]: { result } })).toThrow();
      },
    );
  }

  it.each([null, [], {}, { static: good.static }, { unit: good.unit }, { ...good, extra: { result: 'failure' } },
    { ...good, unit: null }])('refuses absent or unexpected dependencies: %j', (needs) => {
    expect(() => assertSuccessfulNeeds(needs)).toThrow();
  });

  it.each([
    [JSON.stringify(good), 0],
    [JSON.stringify({ ...good, unit: { result: 'failure' } }), 1],
    [JSON.stringify({ ...good, unit: { result: 'cancelled' } }), 1],
    [JSON.stringify({ ...good, static: { result: 'skipped' } }), 1],
    ['{}', 1], ['invalid json', 1], ['', 1],
  ])('propagates the actual gate command exit status for %s', (input, status) => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/ci/gate.ts'], {
      cwd: root, env: { ...process.env, CI_NEEDS: input as string }, encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
  });
});

describe('unit shard coverage guard', () => {
  const complete = ['backend:a', 'backend:b', 'web:c', 'release:d'];
  it('accepts a disjoint union covering every project', () => {
    expect(() => assertCompleteShards(complete, [['web:c', 'backend:a'], ['release:d', 'backend:b']])).not.toThrow();
  });
  it.each([
    [['backend:a'], ['backend:b', 'web:c']],
    [['backend:a', 'web:c'], ['backend:a', 'backend:b', 'release:d']],
    [['backend:a', 'backend:a'], ['backend:b', 'web:c', 'release:d']],
    [['backend:a', 'extra:x'], ['backend:b', 'web:c', 'release:d']],
    [[], complete], [complete], [[], [], complete],
  ].map((shards) => ({ shards })))('rejects omission, duplication, addition and invalid shard counts: %j', ({ shards }) => {
    expect(() => assertCompleteShards(complete, shards)).toThrow();
  });
  it('rejects an empty or duplicated source inventory', () => {
    expect(() => assertCompleteShards([], [[], []])).toThrow();
    expect(() => assertCompleteShards(['a', 'a'], [['a'], ['a']])).toThrow();
  });
});

describe('CI workflow contract', () => {
  it('preserves triggers, permissions, concurrency and the release check name', () => {
    expect(workflow.name).toBe('CI');
    expect(workflow.on).toEqual({ pull_request: null, push: { branches: ['main'] } });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'ci-${{ github.ref }}', 'cancel-in-progress': true });
    expect(REQUIRED_CHECKS).toContain('check');
    expect(jobs.check.name).toBe('check');
    expect(jobs.check.if).toBe('${{ always() }}');
    expect(jobs.check.needs?.slice().sort()).toEqual(Object.keys(jobs).filter((name) => name !== 'check').sort());
    expect(jobs.check.needs?.slice().sort()).toEqual(['static', 'unit']);
    const gate = jobs.check.steps.at(-1);
    expect(gate?.env).toEqual({ CI_NEEDS: '${{ toJSON(needs) }}' });
    expect(gate?.run).toBe('node --experimental-strip-types scripts/ci/gate.ts');
  });

  it('runs static checks independently, keeping every existing operation', () => {
    expect(jobs.static.needs).toBeUndefined();
    expect(jobs.static.if).toBeUndefined();
    const commands = jobs.static.steps.map((step) => step.run ?? '').join('\n');
    for (const command of ['pnpm typecheck', 'pnpm lint', 'pnpm build',
      'pnpm exec tsc --noEmit', 'scripts/ci/gate.ts scripts/ci/inventory.ts scripts/ci/workflow.test.ts',
      'node --experimental-strip-types scripts/ci/inventory.ts',
      'pnpm exec vitest run scripts/ci/workflow.test.ts --maxWorkers=2']) {
      expect(commands).toContain(command);
    }
  });

  it('starts two isolated full-suite shards only after their own install and dist emission', () => {
    expect(jobs.unit.needs).toBeUndefined();
    expect(jobs.unit.if).toBeUndefined();
    expect(jobs.unit.strategy).toEqual({ 'fail-fast': false, 'max-parallel': 2, matrix: { shard: [1, 2] } });
    const runs = jobs.unit.steps.map((step) => step.run ?? '');
    const install = runs.indexOf('pnpm install --frozen-lockfile');
    const typecheck = runs.findIndex((run) => run.endsWith(' pnpm typecheck'));
    const test = runs.findIndex((run) => run.endsWith(' pnpm exec vitest run --shard=${{ matrix.shard }}/2 --maxWorkers=2'));
    expect(install).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(install);
    expect(test).toBeGreaterThan(typecheck);
    expect(runs[test]).not.toMatch(/--(?:exclude|project|changed|retry|passWithNoTests)/);
  });

  it('retains frozen installs and bounded runners without failure suppression', () => {
    for (const job of Object.values(jobs)) {
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBe(30);
      for (const step of job.steps) expect(step.if).toBeUndefined();
    }
    for (const job of [jobs.static, jobs.unit]) {
      expect(job.steps.some((step) => step.uses === 'pnpm/action-setup@v4')).toBe(true);
      expect(job.steps.some((step) => step.run === 'pnpm install --frozen-lockfile')).toBe(true);
      expect(job.steps.find((step) => step.id === 'node')?.with).toEqual({ 'node-version': 22, cache: 'pnpm' });
      expect(job.steps.find((step) => step.name === 'Runner resources and dependency cache')?.env)
        .toEqual({ CACHE_HIT: '${{ steps.node.outputs.cache-hit }}' });
    }
    expect(source).not.toMatch(/continue-on-error|--retry|\|\|\s*true|secrets\.|printenv|upload-artifact|download-artifact/);
  });
});
