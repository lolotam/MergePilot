import { expect, it } from 'vitest';
import { alignJsonKeyOrder } from './json-key-order.js';

const json = (value: unknown, indent = 2) => JSON.stringify(value, null, indent);

it('aligns object keys recursively without changing content', () => {
  const previous = { second: { nested: { b: 2, a: 1 } }, first: true };
  const next = { first: true, second: { nested: { a: 1, b: 2 } } };
  expect(alignJsonKeyOrder(json(previous), json(next))).toBe(json(next));
});

it('preserves previous-only keys in their order and takes no values from next', () => {
  const before = '{"oldB":0,"b":2,"__proto__":3,"oldA":4,"a":1}';
  const after = json({ a: 'changed', ['__proto__']: 9, b: null, newKey: 'new' });
  expect(alignJsonKeyOrder(before, after)).toBe(json({ a: 1, ['__proto__']: 3, b: 2, oldB: 0, oldA: 4 }));
});

it('aligns objects within arrays by position without sorting the array', () => {
  const before = { list: [{ b: 3, a: 2 }, { a: 1, b: 0 }, 'tail'] };
  const after = { list: [{ a: 1, b: 0 }, { b: 3, a: 2 }] };
  expect(alignJsonKeyOrder(json(before), json(after))).toBe(json({
    list: [{ a: 2, b: 3 }, { b: 0, a: 1 }, 'tail'],
  }));
});

it.each([
  ['{', '{}'],
  ['{}', '{'],
  ['[]', '{}'],
  ['{}', 'null'],
  ['{}', '{"a":1}'],
  ['{}', '{\n  "a": 1,\n\t"b": 2\n}'],
  ['{}', '{\n  "a": 1 \n}'],
  ['{}', '{\n  "a": 1\n}\n\n'],
])('rejects invalid, non-object or non-round-tripping JSON (%j, %j)', (previous, next) => {
  expect(alignJsonKeyOrder(previous, next)).toBeNull();
});

it('uses the next file’s indentation and final newline', () => {
  const after = json({ first: 1, second: 2 }, 4) + '\n';
  expect(alignJsonKeyOrder('{"second":2,"first":1}', after)).toBe(after);
});
