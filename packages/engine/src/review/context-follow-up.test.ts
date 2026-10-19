import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import { ContextPlan, type ContextPlanOptions, type RepositoryContextFile } from './context.js';
import { buildReviewPrompt, renderContextFile } from './prompt.js';

// ADR-0030: on a follow-up review the PR's other changed files are PR_CONTEXT. They take at most
// `prContextTokens` of each call's cap (related to the call's files first), repository context
// fills the rest, and what was sent or left out is disclosed apart from repository context.

const PATCH = '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;';

function prChange(path: string, forPaths: string[] = [], content = PATCH): RepositoryContextFile {
  return { path, content, reason: 'changed earlier in this pull request', kind: 'pr-change', forPaths };
}

/** Larger than a PR block, so a PR share that leaked into the repository's room would push it out. */
function repoFile(path: string, forPath = 'src/a.ts'): RepositoryContextFile {
  const content = 'export const x = 1;\n'.repeat(12);
  return { path, content, reason: `imported by ${forPath}`, kind: 'import', forPaths: [forPath] };
}

function options(overrides: Partial<ContextPlanOptions> = {}): ContextPlanOptions {
  return {
    exclude: [],
    knownSecrets: [],
    reviewedPaths: ['src/a.ts', 'src/b.ts'],
    contextTokens: 30_000,
    batchTokens: 24_000,
    prContextTokens: 15_000,
    ...overrides,
  };
}

/** A PR context block's tokens, as the plan counts them (fence overhead included). */
const blockTokens = (file: RepositoryContextFile): number =>
  estimateTokens(renderContextFile({ ...file, source: file.kind === 'pr-change' ? 'pull-request' : undefined })) + 30;

describe('ContextPlan — PR context on a follow-up review (ADR-0030)', () => {
  it.each([{ batchTokens: 500 }, { batchContextTokens: 500 }])('cuts PR files to the batch share and discloses them as sent: %o', (limits) => {
    const content = `@@ -1,1 +1,301 @@\n const a = 1;\n${'+const value = 1;\n'.repeat(300)}`;
    const opts = options(limits);
    const share = Math.min(opts.prContextTokens ?? 0, opts.contextTokens, opts.batchContextTokens ?? opts.batchTokens);
    const plan = new ContextPlan([prChange('lib/earlier.ts', ['src/a.ts'], content)], opts);
    const whole = plan.whole();
    expect(whole[0]?.content).toBe(content);
    expect(whole[0]?.truncated).not.toBe(true);

    const batch = plan.forBatch([{ path: 'src/a.ts' }]);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.truncated).toBe(true);
    expect(batch[0]?.content).toContain('+const value = 1;');
    expect(content.startsWith(batch[0]!.content)).toBe(true);
    expect(estimateTokens(renderContextFile(batch[0]!)) + 30).toBeLessThanOrEqual(share);
    expect(plan.whole()).toEqual(whole);
    expect(plan.disclosure()).toEqual({ sent: [], leftOut: [], pr: { sent: ['lib/earlier.ts'], leftOut: [] } });
  });

  it('sends a PR file related to the reviewed files before a smaller unrelated one', () => {
    const related = prChange('deep/dir/related.ts', ['src/a.ts'], `${PATCH}\n+const c = 3;`);
    const unrelated = prChange('x.ts');
    const plan = new ContextPlan([unrelated, related], options({ prContextTokens: blockTokens(related) + 2 }));

    const whole = plan.whole();
    plan.markSent(whole);

    expect(whole.map((f) => f.path)).toEqual(['deep/dir/related.ts']);
    expect(plan.disclosure()?.pr).toEqual({ sent: ['deep/dir/related.ts'], leftOut: ['x.ts'] });
  });

  it('leaves out a PR file of which not even the first line fits, instead of sending an empty block', () => {
    const oneLine = prChange('lib/data.ts', ['src/a.ts'], `@@ -0,0 +1 @@\n+export const data = [${'1, '.repeat(2000)}];`);
    const plan = new ContextPlan([oneLine], options({ prContextTokens: 120 }));
    const whole = plan.whole();
    plan.markSent(whole);
    expect(whole).toEqual([]);
    expect(plan.disclosure()?.pr).toEqual({ sent: [], leftOut: ['lib/data.ts'] });
  });

  it('keeps PR context within its share, so repository context still fits', () => {
    const pr = [prChange('lib/one.ts', ['src/a.ts']), prChange('lib/two.ts', ['src/a.ts'])];
    const share = blockTokens(pr[0]!) + 2;
    const repo = repoFile('src/dep.ts');
    const plan = new ContextPlan([...pr, repo], options({ prContextTokens: share, contextTokens: share + blockTokens(repo) + 2 }));

    expect(plan.whole().map((f) => f.path)).toEqual(['lib/one.ts', 'src/dep.ts']);
  });

  it('gives each batch the PR files related to its own files first', () => {
    const forA = prChange('lib/for-a.ts', ['src/a.ts']);
    const forB = prChange('lib/for-b.ts', ['src/b.ts']);
    const plan = new ContextPlan([forA, forB], options({ prContextTokens: blockTokens(forB) + 2 }));

    expect(plan.forBatch([{ path: 'src/b.ts' }]).map((f) => f.path)).toEqual(['lib/for-b.ts']);
    expect(plan.forBatch([{ path: 'src/a.ts' }]).map((f) => f.path)).toEqual(['lib/for-a.ts']);
  });

  it('never offers a file this review covers, and offers none without a PR share', () => {
    const offered = [prChange('src/a.ts'), prChange('lib/other.ts')];
    expect(new ContextPlan(offered, options()).whole().map((f) => f.path)).toEqual(['lib/other.ts']);

    const off = new ContextPlan(offered, options({ prContextTokens: 0 }));
    expect(off.whole()).toEqual([]);
    expect(off.disclosure()).toBeUndefined();
  });

  it('renders a PR file as a PR_CONTEXT block numbered like a patch', () => {
    const plan = new ContextPlan([prChange('lib/rel.ts', ['src/a.ts'])], options());
    const user = buildReviewPrompt({
      language: 'en', maxFindings: 5, pr: { title: 't', body: '' }, rulesFiles: [], pathInstructions: [], files: [], contextFiles: plan.whole(),
    }).user;

    expect(user).toContain(
      '<<<UNTRUSTED:PR_CONTEXT:lib/rel.ts>>>\nReason: changed earlier in this pull request\n@@ -1,1 +1,2 @@\n  1   const a = 1;\n  2 + const b = 2;',
    );
    expect(user).not.toContain('REPOSITORY_CONTEXT');
  });
});
