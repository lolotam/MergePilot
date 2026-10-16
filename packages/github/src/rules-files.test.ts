import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { ancestorDirectories, MAX_RULES_DIRECTORIES, withNestedRulesFiles } from './rules-files.js';

const BASE = 'base-sha';

/** A client whose repository, at `BASE` only, holds `files`; every read is recorded. */
function repoClient(files: Record<string, string>, failing: readonly string[] = []) {
  const reads: Array<{ path: string; ref: string }> = [];
  const client: GitHubClient = {
    getFileContent: async ({ path, ref }) => {
      reads.push({ path, ref });
      if (failing.includes(path)) throw new Error('500 from GitHub');
      return ref === BASE ? (files[path] ?? null) : 'HEAD CONTENT MUST NEVER BE READ';
    },
    listPullRequestFilesPage: async () => [],
    getPullRequest: async () => ({ head: { sha: 'head' } }),
    listReviewsPage: async () => [],
    createReview: async () => ({ id: 1 }),
    compareCommits: async () => null,
  };
  return { client, reads };
}

const params = { owner: 'o', repo: 'r', baseSha: BASE };

describe('ancestorDirectories', () => {
  it('lists the directories above a path, deepest first, without the root', () => {
    expect(ancestorDirectories('apps/api/src/x.ts')).toEqual(['apps/api/src', 'apps/api', 'apps']);
    expect(ancestorDirectories('README.md')).toEqual([]);
  });
});

describe('withNestedRulesFiles (ADR-0028)', () => {
  it('adds the nearest AGENTS.md and CLAUDE.md of each changed file, read from the base commit', async () => {
    const { client, reads } = repoClient({
      'apps/AGENTS.md': 'apps agents',
      'apps/api/AGENTS.md': 'api agents',
      'apps/CLAUDE.md': 'apps claude',
    });
    const out = await withNestedRulesFiles(client, {
      ...params,
      rulesFiles: [{ path: 'AGENTS.md', content: 'root' }],
      changedPaths: ['apps/api/src/route.ts', 'apps/web/page.tsx'],
    });
    expect(out.rulesFiles).toEqual([
      { path: 'AGENTS.md', content: 'root' },
      { path: 'apps/AGENTS.md', content: 'apps agents' },
      { path: 'apps/CLAUDE.md', content: 'apps claude' },
      { path: 'apps/api/AGENTS.md', content: 'api agents' },
    ]);
    expect(out.leftOut).toEqual([]);
    expect(reads.every((r) => r.ref === BASE)).toBe(true);
  });

  it('does not add a nested file twice, nor one the configured rules already hold', async () => {
    const { client, reads } = repoClient({ 'pkg/AGENTS.md': 'pkg agents' });
    const out = await withNestedRulesFiles(client, {
      ...params,
      rulesFiles: [{ path: 'pkg/AGENTS.md', content: 'configured copy' }],
      changedPaths: ['pkg/a.ts', 'pkg/b.ts'],
    });
    expect(out.rulesFiles).toEqual([{ path: 'pkg/AGENTS.md', content: 'configured copy' }]);
    expect(reads.map((r) => r.path)).toEqual(['pkg/CLAUDE.md']);
  });

  it('keeps the configured rules, fills the cap shallow and small first, and discloses the rest', async () => {
    const { client } = repoClient({
      'a/AGENTS.md': 'x'.repeat(70),
      'a/CLAUDE.md': 'y'.repeat(35),
      'a/b/AGENTS.md': 'z'.repeat(35),
    });
    const out = await withNestedRulesFiles(client, {
      ...params,
      rulesFiles: [{ path: 'CLAUDE.md', content: 'r'.repeat(35) }],
      changedPaths: ['a/b/c.ts'],
      maxRulesTokens: 30, // 10 tokens per 35 chars: root 10 + a/CLAUDE.md 10 + a/b/AGENTS.md 10
    });
    expect(out.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md', 'a/CLAUDE.md', 'a/b/AGENTS.md']);
    expect(out.leftOut).toEqual([]);

    const tight = await withNestedRulesFiles(client, {
      ...params,
      rulesFiles: [{ path: 'CLAUDE.md', content: 'r'.repeat(35) }],
      changedPaths: ['a/b/c.ts'],
      maxRulesTokens: 20,
    });
    expect(tight.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md', 'a/CLAUDE.md']);
    expect(tight.leftOut).toEqual(['a/b/AGENTS.md']);
  });

  it('looks up at most the directory limit, shallowest first, and names the directories it skipped', async () => {
    const { client, reads } = repoClient({});
    const changedPaths = Array.from({ length: MAX_RULES_DIRECTORIES + 2 }, (_, i) => `d${String(i).padStart(2, '0')}/x.ts`);
    changedPaths.push('d00/deep/y.ts');
    const out = await withNestedRulesFiles(client, { ...params, rulesFiles: [], changedPaths });
    expect(out.leftOut).toHaveLength(3);
    expect(out.leftOut).toContain('d00/deep/ (not looked up)');
    expect(reads).toHaveLength(MAX_RULES_DIRECTORIES * 2);
    expect(reads.map((r) => r.path)).not.toContain('d00/deep/AGENTS.md');
  });

  it('discloses a rules file that could not be read instead of failing or hiding it', async () => {
    const { client } = repoClient({ 'svc/CLAUDE.md': 'svc claude' }, ['svc/AGENTS.md']);
    const out = await withNestedRulesFiles(client, { ...params, rulesFiles: [], changedPaths: ['svc/main.go'] });
    expect(out.rulesFiles).toEqual([{ path: 'svc/CLAUDE.md', content: 'svc claude' }]);
    expect(out.leftOut).toEqual(['svc/AGENTS.md (could not be read)']);
  });

  it('reads each file once per client, so the bots of one panel share the lookups', async () => {
    const { client, reads } = repoClient({ 'svc/AGENTS.md': 'svc' });
    const input = { ...params, rulesFiles: [], changedPaths: ['svc/main.go'] };
    await withNestedRulesFiles(client, input);
    await withNestedRulesFiles(client, input);
    expect(reads).toHaveLength(2); // svc/AGENTS.md and svc/CLAUDE.md, once each
  });
});
