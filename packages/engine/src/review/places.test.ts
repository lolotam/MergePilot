import { expect, it } from 'vitest';
import { placesInText } from './places.js';

it('finds whole known paths in free text and prefers the longer overlapping match', () => {
  const text = 'Compare badsrc/file.ts:9, unknown.ts:3, src/my file.ts:30 and src/file.ts:40.';
  expect(placesInText(text, ['file.ts', 'src/file.ts', 'src/my file.ts', 'src/my'])).toEqual([
    { path: 'src/my file.ts', line: 30 },
    { path: 'src/file.ts', line: 40 },
  ]);
});
