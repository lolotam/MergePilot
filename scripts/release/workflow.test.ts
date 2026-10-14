import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
const release = read('.github/workflows/release.yml');

describe('.github/workflows/release.yml', () => {
  it('runs after the three gate workflows complete on main, or by hand', () => {
    expect(release).toMatch(/workflow_run:\n {4}workflows: \[CI, Integration Tests, Docker Image\]\n {4}types: \[completed\]\n {4}branches: \[main\]/);
    expect(release).toMatch(/workflow_dispatch:/);
    const names = ['.github/workflows/ci.yml', '.github/workflows/integration.yml', '.github/workflows/docker.yml'].map((p) => /^name: (.+)$/m.exec(read(p))?.[1]);
    expect(names).toEqual(['CI', 'Integration Tests', 'Docker Image']);
  });

  it('serialises production releases without cancelling one in progress', () => {
    expect(release).toMatch(/concurrency:\n {2}group: production-release\n {2}cancel-in-progress: false/);
  });

  it('gives the job room for a full deploy plus rollback and tells the script the same limit', () => {
    const job = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(release)?.[1]);
    expect(job).toBeGreaterThanOrEqual(2 * (35 + 10) + 10);
    expect(release).toContain(`JOB_TIMEOUT_MINUTES: ${job}`);
  });

  it('accepts only main pushes from this repository, never pull requests or forks', () => {
    expect(release).toContain("github.event.workflow_run.event == 'push'");
    expect(release).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(release).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    expect(release).toContain("github.ref == 'refs/heads/main'");
    expect(release).not.toMatch(/pull_request/);
  });

  it('runs release code from main with least privilege and stays a dry run unless enabled', () => {
    expect(release).toMatch(/^permissions: \{\}$/m);
    expect(release).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(release).toContain('persist-credentials: false');
    expect(release).toMatch(/permissions:\n {6}contents: write[^\n]*\n {6}issues: write[^\n]*\n {6}checks: read/);
    expect(release).toContain('MERGEPILOT_AUTO_RELEASE: ${{ vars.MERGEPILOT_AUTO_RELEASE }}');
    expect(release).toContain('DOKPLOY_API_KEY: ${{ secrets.DOKPLOY_API_KEY }}');
    expect(release).not.toMatch(/echo .*secrets\./);
  });

  it('is not itself a gate workflow and is never triggered by the release branch', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/integration.yml', '.github/workflows/docker.yml']) {
      expect(read(path), path).not.toMatch(/production/);
    }
  });
});
