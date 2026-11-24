import { expect, it } from 'vitest';
import { alsoAtBlockRange, alsoAtPlaces, alsoAtPlacesWithFallback, placesInText } from './places.js';

it('finds whole known paths in free text and prefers the longer overlapping match', () => {
  const text = 'Compare badsrc/file.ts:9, unknown.ts:3, src/my file.ts:30 and src/file.ts:40.';
  expect(placesInText(text, ['file.ts', 'src/file.ts', 'src/my file.ts', 'src/my'])).toEqual([
    { path: 'src/my file.ts', line: 30 },
    { path: 'src/file.ts', line: 40 },
  ]);
});

it('stops Also at block parsing before code fences and prose sentences', () => {
  const withFence = 'Also at: a.ts:10\n```ts\n// b.ts:20\n```';
  expect(alsoAtPlaces(withFence, ['a.ts', 'b.ts'])).toEqual([{ path: 'a.ts', line: 10 }]);
  expect(alsoAtBlockRange(withFence)).toMatchObject({ start: 0, end: 'Also at: a.ts:10'.length });

  const withProse = 'Also at: a.ts:10\nSee src/helper.ts:20 for why this happens.';
  expect(alsoAtPlaces(withProse, ['a.ts', 'src/helper.ts'])).toEqual([{ path: 'a.ts', line: 10 }]);
  expect(alsoAtBlockRange(withProse)).toMatchObject({ start: 0, end: 'Also at: a.ts:10'.length });
});

it('parses spaces, multiple dots, nested paths, and extensionless filenames without duplicating known paths', () => {
  const body = 'Also at: src/my file.ts:30, src/lib/foo.test.ts:45, Makefile:12, `docs/my doc.md:8`';
  expect(alsoAtPlacesWithFallback(body, ['src/my file.ts'])).toEqual([
    { path: 'src/my file.ts', line: 30 },
    { path: 'src/lib/foo.test.ts', line: 45 },
    { path: 'Makefile', line: 12 },
    { path: 'docs/my doc.md', line: 8 },
  ]);
});

it('keeps wrapped continuation lines containing comma-bearing known paths alongside other entries', () => {
  const body = 'Also at: src/entry.ts:10,\n  src/report, draft.ts:20, src/worker.ts:30';
  expect(alsoAtPlaces(body, ['src/entry.ts', 'src/report, draft.ts', 'src/worker.ts'])).toEqual([
    { path: 'src/entry.ts', line: 10 },
    { path: 'src/report, draft.ts', line: 20 },
    { path: 'src/worker.ts', line: 30 },
  ]);
});
