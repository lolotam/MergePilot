import { describe, expect, it } from 'vitest';
import { countChangedLines, isDesignDocPath, isDesignReview } from './design-review.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A patch with `added` added lines and `removed` removed lines. */
function patch(added: number, removed = 0): string {
  const lines = [`@@ -1,1 +1,${added} @@`];
  for (let i = 0; i < added; i++) lines.push('+x');
  for (let i = 0; i < removed; i++) lines.push('-y');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isDesignDocPath', () => {
  it.each([
    'docs/specs/030-staff/spec.md',
    'docs/specs/030-staff/schema.sql',
    'docs/adr/0040-design-review-mode.md',
    'docs/prd/v0.2.ar.md',
    'apps/api/SPEC.md',
    'plan.md',
    'docs/finance-design.md',
    'roadmap.md',
    'docs/specification.md',
    'apps/api-spec.md',
    'docs\\specs\\031\\plan.md',
  ])('treats %s as a design document', (path) => {
    expect(isDesignDocPath(path)).toBe(true);
  });

  it.each([
    'README.md',
    'src/design/tokens.ts',
    'src/spec.ts',
    'packages/engine/src/review/prompt.ts',
    'docs/usage.md',
    'docs/inspection.md',
    'apps/api/migrations/001.sql',
  ])('does not treat %s as a design document', (path) => {
    expect(isDesignDocPath(path)).toBe(false);
  });
});

describe('countChangedLines', () => {
  it('counts added and removed lines only', () => {
    const p = [
      '@@ -1,4 +1,5 @@',
      '+x',
      ' context',
      '-y',
      '+++i;',
      '----',
      '\\ No newline at end of file',
    ].join('\n');
    // '+x', '-y', '+++i;' and '----'; the context line, the hunk header and the marker do not count.
    expect(countChangedLines(p)).toBe(4);
  });

  it('counts nothing in an empty patch', () => {
    expect(countChangedLines('')).toBe(0);
  });
});

describe('isDesignReview', () => {
  it('is false without files', () => {
    expect(isDesignReview([])).toBe(false);
  });

  it('is false when the patches hold no changed line', () => {
    const files = [{ path: 'docs/specs/1/spec.md', patch: '@@ -1,1 +1,1 @@\n context' }];
    expect(isDesignReview(files)).toBe(false);
  });

  it('is true for a spec-only call', () => {
    const files = [{ path: 'docs/specs/1/spec.md', patch: patch(40) }];
    expect(isDesignReview(files)).toBe(true);
  });

  it('is false for a code-only call', () => {
    const files = [{ path: 'src/a.ts', patch: patch(40) }];
    expect(isDesignReview(files)).toBe(false);
  });

  it('follows the majority of the changed lines', () => {
    const spec = { path: 'docs/specs/1/spec.md' };
    const code = { path: 'src/a.ts' };

    expect(isDesignReview([{ ...spec, patch: patch(30) }, { ...code, patch: patch(10) }])).toBe(true);
    expect(isDesignReview([{ ...spec, patch: patch(10) }, { ...code, patch: patch(30) }])).toBe(false);
    // Exactly half counts as a design review.
    expect(isDesignReview([{ ...spec, patch: patch(20) }, { ...code, patch: patch(20) }])).toBe(true);
  });

  it('counts removed lines too', () => {
    const files = [
      { path: 'docs/specs/1/spec.md', patch: patch(0, 25) },
      { path: 'src/a.ts', patch: patch(20) },
    ];
    expect(isDesignReview(files)).toBe(true);
  });
});
