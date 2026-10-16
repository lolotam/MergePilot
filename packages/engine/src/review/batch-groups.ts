/**
 * How the files of a huge PR are grouped and ordered before they are cut into batches (ADR-0031).
 * An implementation and its sibling test, and the code files of one directory, form one group, so
 * a batch sees them together. Groups go in order of review value: source, then tests, then
 * config/CI, then docs and generated-like files, so the time limit drops the least valuable
 * batches. Paths only: nothing is read, parsed or run.
 */

import { isLockfile } from '../diff/classify-file.js';

/** Review value of a file, most valuable first. */
export const FileTier = { Source: 0, Test: 1, Config: 2, Docs: 3 } as const;
export type FileTier = (typeof FileTier)[keyof typeof FileTier];

const DOC_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'rst', 'adoc', 'txt']);
/** Extensionless only: `notice.tsx` or `changes.ts` is code; `LICENSE.md` is caught by its extension. */
const DOC_NAMES = /^(license|licence|changelog|changes|authors|notice|copying|codeowners)$/i;
const GENERATED_SEGMENTS = new Set(['__snapshots__', 'generated', 'vendor']);
const CI_SEGMENTS = new Set(['.github', '.circleci', '.gitlab', '.husky', '.devcontainer', '.vscode']);
const CONFIG_EXTENSIONS = new Set(['json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties']);
const CONFIG_NAMES = /^(dockerfile|makefile|procfile|jenkinsfile|cmakelists\.txt|requirements[^/]*\.txt|docker-compose[^/]*|.*\.dockerfile)$/i;
/** Tool configs by name only: an application `app.config.ts` is code and stays with its test. */
const TOOL_CONFIG_NAMES =
  /^(vite|vitest|eslint|jest|webpack|rollup|babel|postcss|tailwind|prettier|next|nuxt|svelte|astro|playwright|cypress|tsup|esbuild|karma|commitlint|stylelint|metro|drizzle|turbo|lint-staged)\.config\.[cm]?[jt]s$/i;
const TEST_SEGMENTS = new Set(['__tests__', '__mocks__', '__fixtures__', 'test', 'tests', 'spec', 'specs', 'testdata']);
const TEST_NAME = /(\.(test|spec|fixtures?)\.[^.]+$)|(^test_.+\.py$)|(_test\.(py|go)$)|(^conftest\.py$)/;

function splitPath(path: string): { dirs: string[]; base: string; extension: string } {
  const segments = path.replace(/\\/g, '/').split('/');
  const base = segments.pop() ?? '';
  const extension = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return { dirs: segments, base, extension };
}

/** Where a file sits in the review order. */
export function fileTierOf(path: string): FileTier {
  const { dirs, base, extension } = splitPath(path);
  const lower = base.toLowerCase();
  if (CONFIG_NAMES.test(lower) || TOOL_CONFIG_NAMES.test(lower)) return FileTier.Config;
  // Lockfiles, dist/, minified and *.generated.* files never reach a batch: classifyFile skips them.
  if (DOC_EXTENSIONS.has(extension) || DOC_NAMES.test(lower) || isLockfile(lower) || lower.endsWith('.snap')) {
    return FileTier.Docs;
  }
  if (dirs.some((d) => GENERATED_SEGMENTS.has(d.toLowerCase()))) return FileTier.Docs;
  if (dirs.some((d) => CI_SEGMENTS.has(d.toLowerCase()))) return FileTier.Config;
  if (TEST_NAME.test(lower) || dirs.some((d) => TEST_SEGMENTS.has(d.toLowerCase()))) return FileTier.Test;
  if (CONFIG_EXTENSIONS.has(extension) || base.startsWith('.')) return FileTier.Config;
  return FileTier.Source;
}

/**
 * The implementation a file belongs to, as `dir/stem`: `x.test.ts`, `x.spec.ts` and
 * `__tests__/x.test.ts` give the key of `x.ts`; Python `test_x.py`, `x_test.py` and
 * `tests/test_x.py` the key of `x.py`; Go `x_test.go` the key of `x.go` (the pairs of ADR-0029).
 */
export function implementationKeyOf(path: string): string {
  const { dirs, base } = splitPath(path);
  // Only the final extension goes: `user.service.ts` and `user.controller.ts` are two units.
  let stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  let parent = dirs;
  const jsTest = /^(.+)\.(test|spec)\.[^.]+$/.exec(base);
  if (jsTest) {
    stem = jsTest[1]!;
    if (parent[parent.length - 1] === '__tests__') parent = parent.slice(0, -1);
  } else if (/^test_.+\.py$/.test(base)) {
    stem = stem.slice('test_'.length);
    if (parent[parent.length - 1] === 'tests') parent = parent.slice(0, -1);
  } else if (/_test\.(py|go)$/.test(base)) {
    stem = stem.slice(0, -'_test'.length);
  }
  return [...parent, stem].join('/');
}

/** A unit of batching: it goes into one batch whole when it fits the cap, else its children do. */
export interface BatchNode<T> {
  files: T[];
  tokens: number;
  /** Absent on a single file: a file bigger than the cap is truncated (ADR-0013). */
  children?: BatchNode<T>[] | undefined;
}

interface Member<T> {
  file: T;
  index: number;
  tier: FileTier;
  tokens: number;
}

const dirOf = (key: string): string => key.slice(0, Math.max(0, key.lastIndexOf('/')));

function nodeOf<T>(members: readonly Member<T>[], children?: BatchNode<T>[]): BatchNode<T> {
  return {
    files: members.map((m) => m.file),
    tokens: members.reduce((sum, m) => sum + m.tokens, 0),
    ...(children ? { children } : {}),
  };
}

/** Appends `value` to the list under `key`, keeping the keys in first-seen order. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Groups files for batching, in review order. Code files (source and tests) group by the directory
 * of the implementation they belong to, so `src/x.ts`, `src/x.test.ts` and
 * `src/__tests__/y.test.ts` share a group; config and docs files group by directory among their
 * own tier. A group takes the tier of its most valuable file; groups of one tier keep the PR's
 * order. Within a group, units with source come before test-only units, and each implementation
 * comes right before its tests (one unit node).
 */
export function groupFilesForBatches<T extends { path: string }>(
  files: readonly T[],
  tokensOf: (file: T) => number,
): BatchNode<T>[] {
  const groups = new Map<string, Map<string, Member<T>[]>>();
  files.forEach((file, index) => {
    const tier = fileTierOf(file.path);
    const unit = implementationKeyOf(file.path);
    const key = tier <= FileTier.Test ? `code:${dirOf(unit)}` : `${tier}:${dirOf(file.path)}`;
    if (!groups.has(key)) groups.set(key, new Map());
    push(groups.get(key)!, unit, { file, index, tier, tokens: tokensOf(file) });
  });
  const ordered = [...groups.values()].map((units) => {
    const nodes = [...units.values()]
      .map((unit) => {
        const members = [...unit].sort((a, b) => a.tier - b.tier || a.index - b.index);
        return { members, node: nodeOf(members, members.map((m) => nodeOf([m]))) };
      })
      // Units with source first, so a group split over the cap never schedules a test-only batch
      // ahead of its source; then the PR's order.
      .sort((a, b) => a.members[0]!.tier - b.members[0]!.tier || a.members[0]!.index - b.members[0]!.index);
    const members = nodes.flatMap((n) => n.members);
    return {
      tier: Math.min(...members.map((m) => m.tier)),
      first: Math.min(...members.map((m) => m.index)),
      node: nodeOf(members, nodes.map((n) => n.node)),
    };
  });
  return ordered.sort((a, b) => a.tier - b.tier || a.first - b.first).map((group) => group.node);
}
