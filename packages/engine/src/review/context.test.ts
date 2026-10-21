import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import { ContextPlan, MAX_SCALED_CONTEXT_TOKENS, scaledContextTokens, type ContextPlanOptions, type RepositoryContextFile } from './context.js';
import { buildReviewPrompt, CONTEXT_TRUNCATED_MARKER, renderContextFile } from './prompt.js';

// ADR-0029: repository context is filtered, redacted, capped per file and fitted per call in
// priority order (changed file > cited > referenced > test pair > import, ADR-0041), and what was
// left out is counted.

function file(path: string, kind: RepositoryContextFile['kind'], content = 'export const x = 1;', forPaths = ['src/a.ts']): RepositoryContextFile {
  return { path, content, reason: `${kind} for test`, kind, forPaths };
}

function options(overrides: Partial<ContextPlanOptions> = {}): ContextPlanOptions {
  return { exclude: [], knownSecrets: [], reviewedPaths: ['src/a.ts', 'src/b.ts'], contextTokens: 30_000, batchTokens: 24_000, ...overrides };
}

describe('ContextPlan', () => {
  const tokens = (files: ReturnType<ContextPlan['whole']>) =>
    files.reduce((sum, f) => sum + estimateTokens(renderContextFile(f)) + 30, 0);

  it.each([
    { contextTokens: 1_000, contextTokensPerFile: 2_000, batchTokens: 1_000 },
    { batchContextTokens: 500 },
    { batchTokens: 500 },
  ])('cuts repository files to the batch cap without changing the whole-PR version: %o', (limits) => {
    const content = 'export const value = 1;\n'.repeat(300);
    const opts = options(limits);
    const cap = Math.min(opts.contextTokens, opts.batchContextTokens ?? opts.batchTokens);
    const plan = new ContextPlan([file('src/ref.ts', 'cited', content, ['src/a.ts', 'src/b.ts'])], opts);
    const whole = plan.whole();
    expect(whole).toHaveLength(1);
    expect(whole[0]?.content).toBe(content);
    expect(whole[0]?.truncated).not.toBe(true);

    const batch = plan.forBatch([{ path: 'src/a.ts' }]);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.truncated).toBe(true);
    expect(batch[0]?.content.length).toBeGreaterThan(0);
    expect(content.startsWith(batch[0]!.content)).toBe(true);
    expect(tokens(batch)).toBeLessThanOrEqual(cap);
    expect(plan.forBatch([{ path: 'src/b.ts' }])).toEqual(batch);
    expect(plan.whole()).toEqual(whole);
    expect(plan.disclosure()).toEqual({ sent: ['src/ref.ts'], leftOut: [], cited: ['src/ref.ts'] });
  });

  it.each([true, false])('keeps the longest sent version for verification, whole first: %s', (wholeFirst) => {
    const plan = new ContextPlan([file('src/ref.ts', 'cited', 'const value = 1;\n'.repeat(300))], options({ batchContextTokens: 500 }));
    const whole = plan.whole();
    if (wholeFirst) plan.markSent(whole);
    const batch = plan.forBatch([{ path: 'src/a.ts' }]);
    if (!wholeFirst) plan.markSent(whole);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.truncated).toBe(true);
    expect(plan.sentFiles()).toEqual(whole);
    expect(plan.disclosure()).toEqual({ sent: ['src/ref.ts'], leftOut: [], cited: ['src/ref.ts'] });
  });

  it('decouples the batch context cap and preserves the old cap when unset', () => {
    const offered = [file('src/ref.ts', 'cited', 'const x = 1;\n'.repeat(100))];
    const defaultCap = new ContextPlan(offered, options({ batchTokens: 100 })).forBatch([{ path: 'src/a.ts' }]);
    expect(defaultCap).toHaveLength(1);
    expect(defaultCap[0]?.truncated).toBe(true);
    expect(tokens(defaultCap)).toBeLessThanOrEqual(100);
    expect(new ContextPlan(offered, options({ batchTokens: 100, batchContextTokens: 2_000 })).forBatch([{ path: 'src/a.ts' }])).toHaveLength(1);
    const capped = new ContextPlan(offered, options({ contextTokens: 100, batchContextTokens: 2_000 })).forBatch([{ path: 'src/a.ts' }]);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.truncated).toBe(true);
    expect(tokens(capped)).toBeLessThanOrEqual(100);
    expect(new ContextPlan(offered, options({ batchContextTokens: 0 })).forBatch([{ path: 'src/a.ts' }])).toEqual([]);
  });

  it('scales only the whole-PR budget, capped at 400000, and keeps zero disabled', () => {
    const offered = Array.from({ length: 80 }, (_, i) => file(`src/ref${i}.ts`, 'cited', 'const x = 1;\n'.repeat(1500)));
    const plan = new ContextPlan(offered, options({ contextTokens: 1_000, contextTokensPerFile: 1_000_000 }));
    const tokens = (files: ReturnType<ContextPlan['whole']>) => files.reduce((sum, f) => sum + estimateTokens(renderContextFile(f)) + 30, 0);
    expect(tokens(plan.whole())).toBeGreaterThan(390_000);
    expect(tokens(plan.whole())).toBeLessThanOrEqual(MAX_SCALED_CONTEXT_TOKENS);
    expect(tokens(plan.forBatch([{ path: 'src/a.ts' }]))).toBeLessThanOrEqual(1_000);
    expect(scaledContextTokens(1_000, 500, 3)).toBe(2_500);
    expect(scaledContextTokens(1_000, 0, 3)).toBe(1_000);
    expect(scaledContextTokens(0, 500, 3)).toBe(0);
  });

  it('ranks cited files before imports and redacts their contents', () => {
    const token = 'gh' + 'p_' + 'a'.repeat(36);
    const plan = new ContextPlan([
      file('src/import.ts', 'import'), file('docs/ref.md', 'cited', `token ${token}`),
      file('src/a.test.ts', 'test-pair'), file('src/a.ts', 'changed-file'),
    ], options());
    const shown = plan.whole();
    expect(shown.map((f) => f.path)).toEqual(['src/a.ts', 'docs/ref.md', 'src/a.test.ts', 'src/import.ts']);
    expect(shown[1]!.content).not.toContain(token);
    expect(shown[1]!.content).toContain('[REDACTED:github]');
    plan.markSent(shown);
    expect(plan.disclosure()?.sent).toContain('docs/ref.md');
  });

  it('caps the incremental PR share by the configured batch cap and base context budget', () => {
    const offered = [file('src/earlier.ts', 'pr-change', '+const x = 1;\n'.repeat(100), [])];
    const batchCapped = new ContextPlan(offered, options({ batchTokens: 100, prContextTokens: 3_000 })).forBatch([{ path: 'src/a.ts' }]);
    expect(batchCapped).toHaveLength(1);
    expect(batchCapped[0]?.truncated).toBe(true);
    expect(tokens(batchCapped)).toBeLessThanOrEqual(100);
    expect(new ContextPlan(offered, options({ batchTokens: 100, batchContextTokens: 2_000, prContextTokens: 3_000 })).forBatch([{ path: 'src/a.ts' }])).toHaveLength(1);
    const capped = new ContextPlan(offered, options({ batchContextTokens: 2_000, prContextTokens: 100 })).forBatch([{ path: 'src/a.ts' }]);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.truncated).toBe(true);
    expect(tokens(capped)).toBeLessThanOrEqual(100);
  });
  it('sends the changed file, then its test, then its imports, and counts what did not fit', () => {
    const body = 'const value = 1;\n'.repeat(20);
    const offered = [
      file('src/dep.ts', 'import', body),
      file('src/a.test.ts', 'test-pair', body),
      file('src/a.ts', 'changed-file', body),
    ];
    // Room for the first two blocks (each with its fence overhead), not for the third.
    const blockTokens = (f: RepositoryContextFile): number => estimateTokens(renderContextFile(f)) + 30;
    const cap = blockTokens(offered[2]!) + blockTokens(offered[1]!) + 5;
    const plan = new ContextPlan(offered, options({ contextTokens: cap }));

    const whole = plan.whole();
    expect(whole.map((f) => f.path)).toEqual(['src/a.ts', 'src/a.test.ts']);
    plan.markSent(whole);
    expect(plan.disclosure()).toEqual({ sent: ['src/a.ts', 'src/a.test.ts'], leftOut: ['src/dep.ts'] });
  });

  it('sends the changed file, then the cited and referenced files, before the tests and imports', () => {
    const body = 'const value = 1;\n'.repeat(20);
    const offered = [
      file('src/dep.ts', 'import', body),
      file('src/a.test.ts', 'test-pair', body),
      file('docs/named.md', 'referenced', body),
      file('docs/ref.md', 'cited', body),
      file('src/a.ts', 'changed-file', body),
    ];
    const blockTokens = (f: RepositoryContextFile): number => estimateTokens(renderContextFile(f)) + 30;
    const one = blockTokens(offered[4]!);

    const twoBlocks = new ContextPlan(offered, options({ contextTokens: one * 2 + 5 }));
    const whole = twoBlocks.whole();
    expect(whole.map((f) => f.path)).toEqual(['src/a.ts', 'docs/ref.md']);
    twoBlocks.markSent(whole);
    expect(twoBlocks.disclosure()?.leftOut).toEqual(['docs/named.md', 'src/a.test.ts', 'src/dep.ts']);

    const threeBlocks = new ContextPlan(offered, options({ contextTokens: one * 3 + 5 }));
    expect(threeBlocks.whole().map((f) => f.path)).toEqual(['src/a.ts', 'docs/ref.md', 'docs/named.md']);
  });

  it('names the sent cited and referenced files in the disclosure, and the imports not', () => {
    const plan = new ContextPlan([
      file('docs/ref.md', 'cited'),
      file('docs/named.md', 'referenced'),
      file('src/dep.ts', 'import'),
    ], options());
    plan.markSent(plan.whole());
    expect(plan.disclosure()?.cited).toEqual(['docs/ref.md', 'docs/named.md']);

    const withoutCitations = new ContextPlan([file('src/dep.ts', 'import')], options());
    withoutCitations.markSent(withoutCitations.whole());
    expect(withoutCitations.disclosure()?.cited).toBeUndefined();
  });

  it('names a changed file another changed file cites, though the merge keeps it a changed file', () => {
    const plan = new ContextPlan([
      file('src/a.ts', 'changed-file'),
      file('src/a.ts', 'cited', 'export const x = 1;', ['src/b.ts']),
    ], options());
    plan.markSent(plan.whole());
    expect(plan.disclosure()?.cited).toEqual(['src/a.ts']);
  });

  it('lists cited files from outside the diff before cited changed files', () => {
    const plan = new ContextPlan([
      file('src/a.ts', 'changed-file'),
      file('src/a.ts', 'referenced', 'export const x = 1;', ['src/a.ts', 'src/b.ts']),
      file('docs/ref.md', 'referenced', 'reference', ['src/a.ts', 'src/b.ts']),
    ], options());
    plan.markSent(plan.whole());
    expect(plan.disclosure()?.sent).toEqual(['src/a.ts', 'docs/ref.md']);
    expect(plan.disclosure()?.cited).toEqual(['docs/ref.md', 'src/a.ts']);
  });

  it('sends build and CI wiring after the imports, and a changed manifest only once as the changed file', () => {
    const offered = [
      file('.github/workflows/ci.yml', 'build-config', 'run: pnpm test'),
      file('package.json', 'build-config', '{ "scripts": {} }'),
      file('src/dep.ts', 'import'),
      file('package.json', 'changed-file', '{ "scripts": {} }', ['src/b.ts']),
    ];
    const plan = new ContextPlan(offered, options());

    expect(plan.whole().map((f) => [f.path, f.reason])).toEqual([
      ['package.json', 'changed-file for test'],
      ['src/dep.ts', 'import for test'],
      ['.github/workflows/ci.yml', 'build-config for test'],
    ]);
  });

  it('cuts a file over its cap at a line break and marks it truncated', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const plan = new ContextPlan([file('src/big.ts', 'import', long)], options({ contextTokens: 500 }));

    const [shown] = plan.whole();
    expect(shown?.truncated).toBe(true);
    expect(long.startsWith(shown!.content)).toBe(true);
    expect(shown!.content.endsWith(';')).toBe(true);
    const user = buildReviewPrompt({
      language: 'en', maxFindings: 5, pr: { title: 't', body: '' }, rulesFiles: [], pathInstructions: [], files: [], contextFiles: [shown!],
    }).user;
    expect(user).toContain(`\n${CONTEXT_TRUNCATED_MARKER}\n<<<END UNTRUSTED:REPOSITORY_CONTEXT:src/big.ts>>>`);
  });

  it('never offers sensitive, binary, lock, generated or excluded files', () => {
    const offered = [
      file('.env', 'import'),
      file('certs/server.pem', 'import'),
      file('assets/logo.png', 'import'),
      file('pnpm-lock.yaml', 'import'),
      file('Cargo.lock', 'import'),
      file('packages/x/dist/index.js', 'import'),
      file('src/app.min.js', 'import'),
      file('src/legacy/old.ts', 'import'),
      file('src/blob.ts', 'import', 'binary\u0000data'),
      file('src/ok.ts', 'import'),
    ];
    const plan = new ContextPlan(offered, options({ exclude: ['src/legacy/**'] }));
    expect(plan.whole().map((f) => f.path)).toEqual(['src/ok.ts']);
  });

  it('gives a batch only the context gathered for its own files, and records it as sent', () => {
    const plan = new ContextPlan(
      [file('src/for-a.ts', 'import', 'a', ['src/a.ts']), file('src/for-b.ts', 'import', 'b', ['src/b.ts'])],
      options(),
    );
    expect(plan.forBatch([{ path: 'src/b.ts' }]).map((f) => f.path)).toEqual(['src/for-b.ts']);
    expect(plan.sentFiles().map((f) => f.path)).toEqual(['src/for-b.ts']);
    expect(plan.disclosure()).toEqual({ sent: ['src/for-b.ts'], leftOut: ['src/for-a.ts'] });
  });

  it("skips an added file's import context in its own batch and sends it to the batch importing it", () => {
    // src/b.ts is an added file imported by src/a.ts: its patch is in its own batch already.
    const plan = new ContextPlan([file('src/b.ts', 'import', 'export const b = 1;', ['src/a.ts'])], options());
    expect(plan.forBatch([{ path: 'src/a.ts' }, { path: 'src/b.ts' }])).toEqual([]);
    expect(plan.forBatch([{ path: 'src/a.ts' }]).map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('does not disclose a file as left out when its own patch was in the call', () => {
    const plan = new ContextPlan([file('src/b.ts', 'import', 'export const b = 1;', ['src/a.ts'])], options());
    plan.markSent(plan.whole());
    expect(plan.disclosure()).toEqual({ sent: [], leftOut: [] });
  });

  it('leaves out a file of which not even the first line fits, instead of sending an empty block', () => {
    const oneLine = `export const data = [${'1, '.repeat(5000)}];`;
    const plan = new ContextPlan([file('src/data.ts', 'import', oneLine), file('src/ok.ts', 'import')], options({ contextTokens: 800 }));
    const whole = plan.whole();
    expect(whole.map((f) => f.path)).toEqual(['src/ok.ts']);
    plan.markSent(whole);
    expect(plan.disclosure()?.leftOut).toContain('src/data.ts');
  });

  it('sends nothing and discloses nothing when review.contextTokens is 0', () => {
    const plan = new ContextPlan([file('src/dep.ts', 'import')], options({ contextTokens: 0 }));
    expect(plan.whole()).toEqual([]);
    expect(plan.forBatch([{ path: 'src/a.ts' }])).toEqual([]);
    expect(plan.disclosure()).toBeUndefined();
  });
});
