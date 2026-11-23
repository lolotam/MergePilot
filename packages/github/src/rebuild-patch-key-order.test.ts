import { parsePatch } from '@mergepilot/engine';
import { expect, it } from 'vitest';
import { rebuildMissingPatches } from './rebuild-patch.js';
import { fakeClient, OPTS } from './rebuild-patch.fixtures.js';

const folder = 'packages/db/migrations/meta';
const previousName = '0237_snapshot.json';
const path = `${folder}/0238_snapshot.json`;

function snapshot(next: boolean, addColumn = false): string {
  const tables = Object.fromEntries(Array.from({ length: 400 }, (_, index) => {
    const name = `table_${index}`;
    const columns = { id: { type: 'integer' }, ...(addColumn && index === 200 ? { extra: { type: 'text' } } : {}) };
    const indexes = { unique_id: next
      ? { isUnique: true, with: {}, method: 'btree', concurrently: false }
      : { isUnique: true, concurrently: false, method: 'btree', with: {} } };
    const foreignKeys = { parent_id: next
      ? { tableTo: 'parent', tableFrom: name, columnsFrom: ['id'], columnsTo: ['id'], onUpdate: 'cascade', onDelete: 'restrict' }
      : { tableFrom: name, columnsFrom: ['id'], tableTo: 'parent', columnsTo: ['id'], onDelete: 'restrict', onUpdate: 'cascade' } };
    return [name, { columns, indexes, foreignKeys }] as const;
  }));
  return JSON.stringify({ id: next ? 'next' : 'current', prevId: next ? 'current' : 'prior', tables }, null, 2) + '\n';
}

function rebuild(before: string, after: string) {
  const { client } = fakeClient({
    [`base-sha:${folder}/${previousName}`]: before,
    [`head-sha:${path}`]: after,
  }, { [`base-sha:${folder}`]: [previousName] });
  return rebuildMissingPatches(client, [
    { path, status: 'added', additions: after.split('\n').length - 1, deletions: 0, changes: 1 },
  ], OPTS);
}

it('emits only the two changed IDs and their context at the true head line numbers', async () => {
  const next = snapshot(true);
  const result = await rebuild(snapshot(false), next);
  expect(result.rebuilt).toEqual([path]);
  expect(result.snapshotDiffs).toEqual([{ path, previous: previousName }]);
  expect(result.failed).toEqual([]);
  const patch = result.files[0]!.patch!;
  const [header, ...body] = patch.split('\n');
  expect(header).toMatch(/^@@ -0,0 \+1,6 @@ /);
  expect(body).toEqual(next.split('\n').slice(0, 6).map((line) => '+' + line));
});

it('keeps an added column at its real line number in a later hunk', async () => {
  const next = snapshot(true, true);
  const result = await rebuild(snapshot(false), next);
  const patch = result.files[0]!.patch!;
  const headLines = next.split('\n');
  const line = headLines.findIndex((text) => text.includes('"extra": {')) + 1;
  const parsed = parsePatch(patch);
  expect(parsed.addedLines.has(line)).toBe(true);
  expect(parsed.addedLines.has(line + 1)).toBe(true);
  expect(patch).toContain(`+${headLines[line - 1]}\n+${headLines[line]}`);
});

it('uses the raw patch when the head formatting cannot round-trip', async () => {
  const result = await rebuild('{\n  "a": 1,\n  "b": 2\n}\n', '{\n  "b": 2,\n\t"a": 1\n}\n');
  expect(result.files[0]?.patch).toBe([
    '@@ -0,0 +1,4 @@ compared with 0237_snapshot.json: only the regions that differ are shown',
    '+{', '+  "b": 2,', '+\t"a": 1', '+}',
  ].join('\n'));
});
