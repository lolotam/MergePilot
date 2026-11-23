import { expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { classifyChangedFiles, notShownArtifactLabels } from './changed-files.js';

const snapshot = { path: 'migrations/meta/0001_snapshot.json', status: 'added', changes: 3, additions: 3 };
const source = { path: 'src/run.ts', status: 'added', changes: 1, patch: '@@ -0,0 +1 @@\n+run();' };
const options = { exclude: [], knownSecrets: [] };

it('discloses a patchless artifact in the manifest while reviewing the source', () => {
  const files = [snapshot, source];
  const changed = classifyChangedFiles(files, options);
  expect(changed.incompleteReasons).toEqual([]);
  expect(changed.manifestFiles).toContainEqual(expect.objectContaining({
    label: snapshot.path, skipReason: 'skip-generated',
  }));
  expect(changed.reviewableFiles).toEqual([{ path: source.path, patch: source.patch }]);
  expect(notShownArtifactLabels(files, options)).toEqual([snapshot.path]);
});

it('labels only changed artifacts whose patches are unavailable and redacts known secrets', () => {
  const secret = 'private-path-value-1234';
  const labels = notShownArtifactLabels([
    { ...snapshot, path: 'pnpm-lock.yaml' },
    { ...snapshot, path: 'dist/bundle.js' },
    { ...snapshot, path: 'dist/openapi.json' },
    { ...snapshot, patch: source.patch },
    { ...snapshot, path: 'excluded/openapi.json' },
    { ...snapshot, path: 'swagger.json', status: 'removed' },
    { ...snapshot, path: 'api/openapi.json', changes: 0 },
    { ...snapshot, path: `${secret}/${snapshot.path}` },
  ], { exclude: ['excluded/**'], knownSecrets: [new Secret(secret)] });
  expect(labels).toEqual([`[REDACTED:known]/${snapshot.path}`]);
});

it('keeps a patchless hand-written file incomplete', () => {
  const files = [{ ...snapshot, path: 'spec.md' }];
  expect(classifyChangedFiles(files, options).incompleteReasons).toEqual(['spec.md: patch truncated']);
  expect(notShownArtifactLabels(files, options)).toEqual([]);
});
