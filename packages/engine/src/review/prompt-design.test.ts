import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_INPUT = {
  language: 'en',
  maxFindings: 5,
  pr: { title: 'Add login', body: 'Implements OAuth.' },
  rulesFiles: [],
  pathInstructions: [],
  files: [],
};

function makeFile(path: string, patch: string) {
  return { path, patch };
}

/** A patch with `count` added lines. */
function addedPatch(count: number): string {
  const lines = [`@@ -1,1 +1,${count} @@`];
  for (let i = 0; i < count; i++) lines.push('+x');
  return lines.join('\n');
}

const SPEC_FILE = makeFile('docs/specs/1/spec.md', addedPatch(12));
const CODE_FILE = makeFile('src/a.ts', addedPatch(12));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildReviewPrompt with a design review', () => {
  it.each(['en', 'ar'])('adds the design section in %s', (language) => {
    const { system } = buildReviewPrompt({
      ...MINIMAL_INPUT,
      language,
      files: [SPEC_FILE],
    });
    expect(system).toContain('DESIGN REVIEW:');
    expect(system).toContain('data-integrity or money bug is "high"');
  });

  it('leaves a code-only call without the design section', () => {
    const { system } = buildReviewPrompt({
      ...MINIMAL_INPUT,
      files: [CODE_FILE],
    });
    expect(system).not.toContain('DESIGN REVIEW:');
  });

  it('puts the design section after REPORTING and before the findings limit', () => {
    const { system } = buildReviewPrompt({
      ...MINIMAL_INPUT,
      files: [SPEC_FILE],
    });
    const reporting = system.indexOf('REPORTING:');
    const design = system.indexOf('DESIGN REVIEW:');
    const limit = system.indexOf('Return at most');
    expect(reporting).toBeLessThan(design);
    expect(design).toBeLessThan(limit);
  });

  it('puts the design section before BATCHES on a batched call', () => {
    const { system } = buildReviewPrompt({
      ...MINIMAL_INPUT,
      batch: { number: 1, count: 2, manifest: '2 changed files in 2 batches' },
      files: [SPEC_FILE],
    });
    expect(system).toContain('BATCHES:');
    expect(system).toContain('DESIGN REVIEW:');
    expect(system.indexOf('DESIGN REVIEW:')).toBeLessThan(system.indexOf('BATCHES:'));
  });

  it('keeps a code-only system prompt exactly as it was', () => {
    // A code call is not a design review, so its prompt is the one of a call without files.
    const codeOnly = buildReviewPrompt({ ...MINIMAL_INPUT, files: [CODE_FILE] });
    const withoutFiles = buildReviewPrompt({ ...MINIMAL_INPUT, files: [] });
    expect(codeOnly.system).toBe(withoutFiles.system);
  });
});
