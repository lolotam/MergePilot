import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import { ContextPlan, type ContextPlanOptions, type RepositoryContextFile } from './context.js';
import { buildReviewPrompt, CONTEXT_TRUNCATED_MARKER, renderContextFile } from './prompt.js';

// ADR-0029: repository context is filtered, redacted, capped per file and fitted per call in
// priority order (changed file > test pair > import), and what was left out is counted.

function file(path: string, kind: RepositoryContextFile['kind'], content = 'export const x = 1;', forPaths = ['src/a.ts']): RepositoryContextFile {
  return { path, content, reason: `${kind} for test`, kind, forPaths };
}

function options(overrides: Partial<ContextPlanOptions> = {}): ContextPlanOptions {
  return { exclude: [], knownSecrets: [], reviewedPaths: ['src/a.ts', 'src/b.ts'], contextTokens: 30_000, batchTokens: 24_000, ...overrides };
}

describe('ContextPlan', () => {
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

  it('sends nothing and discloses nothing when review.contextTokens is 0', () => {
    const plan = new ContextPlan([file('src/dep.ts', 'import')], options({ contextTokens: 0 }));
    expect(plan.whole()).toEqual([]);
    expect(plan.forBatch([{ path: 'src/a.ts' }])).toEqual([]);
    expect(plan.disclosure()).toBeUndefined();
  });
});
