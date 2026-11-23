import { describe, expect, it } from 'vitest';
import { classifyFile, isGeneratedArtifactPath } from './classify-file.js';

describe('generated review artifacts', () => {
  it.each([
    'packages/db/migrations/meta/0241_snapshot.json',
    'migrations/meta/0001_snapshot.json',
    'packages\\db\\migrations\\meta\\0241_snapshot.json',
    'packages/contracts/openapi/openapi.json',
    'swagger.json',
    'docs/openapi.v1.json',
    'docs\\SWAGGER-2.JSON',
  ])('recognizes %s', (path) => {
    expect(isGeneratedArtifactPath(path)).toBe(true);
  });

  it.each([
    'api/openapi.yaml',
    'api/swagger.yml',
    'src/openapi.ts',
    'docs/openapi-notes.md',
    'migrations/meta/_journal.json',
    'db/snapshot.json',
    'docs/specs/060/spec.md',
  ])('does not recognize %s', (path) => {
    expect(isGeneratedArtifactPath(path)).toBe(false);
  });

  it('skips a patchless artifact and reviews the same artifact with a patch', () => {
    const file = { path: 'migrations/meta/0001_snapshot.json', status: 'added', changes: 3 };
    const options = { exclude: [], isSensitivePath: () => false };
    expect(classifyFile(file, options)).toBe('skip-generated');
    expect(classifyFile({ ...file, patch: '@@ -0,0 +1 @@\n+{}' }, options)).toBe('review');
    expect(classifyFile({ ...file, status: 'removed' }, options)).toBe('skip-removed');
    expect(classifyFile(file, { ...options, isSensitivePath: () => true })).toBe('skip-sensitive');
    expect(classifyFile(file, { ...options, exclude: ['migrations/**'] })).toBe('skip-excluded');
  });

  it.each(['docs/specs/060/spec.md', 'db/tests/finance.sql'])('reports a missing patch for %s', (path) => {
    expect(classifyFile({ path, status: 'modified', changes: 3 }, { exclude: [], isSensitivePath: () => false }))
      .toBe('incomplete-truncated');
  });
});
