import { describe, expect, it } from 'vitest';
import { matchesGlob } from './glob.js';

describe('matchesGlob', () => {
  it('matches single wildcard * within segments', () => {
    expect(matchesGlob('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/nested/index.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('foo.js', '*.js')).toBe(true);
    expect(matchesGlob('foo.ts', '*.js')).toBe(false);
  });

  it('matches double wildcard ** across segments', () => {
    expect(matchesGlob('src/nested/deep/file.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/nested/deep/file.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('file.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/nested/deep/file.ts', 'src/**/file.ts')).toBe(true);
    expect(matchesGlob('src/file.ts', 'src/**/file.ts')).toBe(true);
  });

  it('matches single character ?', () => {
    expect(matchesGlob('file1.ts', 'file?.ts')).toBe(true);
    expect(matchesGlob('file12.ts', 'file?.ts')).toBe(false);
    expect(matchesGlob('f/le.ts', 'f?le.ts')).toBe(false);
  });

  it('matches basename when pattern has no slashes', () => {
    expect(matchesGlob('README.md', '*.md')).toBe(true);
    expect(matchesGlob('docs/readme.md', '*.md')).toBe(true);
    expect(matchesGlob('deep/nested/path/note.md', '*.md')).toBe(true);
  });

  it('matches directories ending with slash', () => {
    expect(matchesGlob('vendor/lib/bundle.js', 'vendor/')).toBe(true);
    expect(matchesGlob('nested/vendor/lib/bundle.js', 'vendor/')).toBe(true);
    expect(matchesGlob('vendor.ts', 'vendor/')).toBe(false);
  });

  it('handles Windows backslashes in paths', () => {
    expect(matchesGlob('src\\nested\\file.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src\\index.ts', 'src/*.ts')).toBe(true);
  });
});
