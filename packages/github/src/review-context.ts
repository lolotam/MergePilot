/**
 * Repository context for reviews (ADR-0029): for every reviewed file, the full version of the file
 * itself, its sibling test or implementation, and the local modules it imports, all read at the PR
 * HEAD through the per-client read cache. Head content is PR-controlled: the engine redacts it and
 * shows it as UNTRUSTED. Nothing here runs or installs the reviewed code; imports are found by text.
 */
import {
  classifyFile,
  isContextPathAllowed,
  isSensitivePath,
  type ContextDisclosure,
  type ContextKind,
  type RepositoryContextFile,
} from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import { capFileContent } from './contents.js';
import { readAtRef } from './read-cache.js';

/** At most this many file reads per review; what is not looked up is disclosed. */
export const MAX_CONTEXT_READS = 120;

/** Reads run this many at a time, to stay clear of GitHub's secondary rate limits. */
const READ_CONCURRENCY = 8;

const JS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);
/** A `.js`-style specifier names the compiled file: the TypeScript source is tried first. */
const SOURCE_FOR_EMITTED: Readonly<Record<string, readonly string[]>> = {
  js: ['ts', 'tsx', 'js'],
  jsx: ['tsx', 'jsx'],
  mjs: ['mts', 'mjs'],
  cjs: ['cts', 'cjs'],
};
const EXTENSIONLESS_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
/** Imports of assets and data (`./styles.css`, `./data.json`) are not followed. */
const NON_CODE_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'md', 'html', 'txt', 'yml', 'yaml', 'wasm']);

/** Relative specifiers of `import … from`, `export … from`, `import 'x'`, `import('x')`, `require('x')`. */
const JS_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*)\1/g;
/** `from .mod import x`, `from .. import x`. */
const PY_RELATIVE_IMPORT_RE = /^\s*from\s+(\.+)([\w.]*)\s+import\s+([^\n#]+)/gm;

export interface ReviewedFile {
  path: string;
  status: string;
  patch?: string | undefined;
  changes: number;
}

export interface GatherContextParams {
  owner: string;
  repo: string;
  /** The PR head: context shows the code the PR would merge. */
  headSha: string;
  /** The files this review covers; removed, excluded and sensitive ones are skipped. */
  files: readonly ReviewedFile[];
  /** `review.exclude`. */
  exclude: string[];
  /** `review.contextTokens`; 0 reads nothing. */
  contextTokens: number;
}

export interface GatheredContext {
  files: RepositoryContextFile[];
  /** Files the gatherer could not include (read limit, failed read), for the summary. */
  leftOut: string[];
}

/** One thing to look up for a reviewed file: candidate paths in order, the first that exists wins. */
interface Lookup {
  candidates: string[];
  kind: ContextKind;
  reason: string;
  forPath: string;
  /** Named in the summary when the read limit stops it (a speculative test lookup is not). */
  disclose: boolean;
}

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');
const extOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  return base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
};

/** Joins a relative path onto a directory; null when it climbs above the repository root. */
export function joinRelative(dir: string, relative: string): string | null {
  const parts = dir ? dir.split('/') : [];
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/** The relative module specifiers a JS/TS file imports or re-exports; bare packages are ignored. */
export function localImportSpecifiers(content: string): string[] {
  return [...new Set([...content.matchAll(JS_SPECIFIER_RE)].map((m) => m[2]!))];
}

/** The repository paths a JS/TS specifier may name, most likely first (`.js` → `.ts`, index files). */
export function resolveImportCandidates(fromPath: string, specifier: string): string[] {
  const target = joinRelative(dirOf(fromPath), specifier);
  if (!target) return [];
  const ext = extOf(target);
  // Own keys only: `./service.constructor` must not resolve through Object.prototype.
  const emitted = Object.hasOwn(SOURCE_FOR_EMITTED, ext) ? SOURCE_FOR_EMITTED[ext] : undefined;
  if (emitted) return emitted.map((e) => `${target.slice(0, -ext.length)}${e}`);
  if (JS_EXTENSIONS.has(ext)) return [target];
  if (NON_CODE_EXTENSIONS.has(ext)) return [];
  // No extension, or a dotted name such as `./user.service`: an extensionless module.
  return EXTENSIONLESS_SUFFIXES.map((suffix) => `${target}${suffix}`);
}

/** Python relative imports of a file, each as its candidate paths (`x.py`, then `x/__init__.py`). */
export function pythonImportCandidates(fromPath: string, content: string): string[][] {
  const groups: string[][] = [];
  for (const match of content.matchAll(PY_RELATIVE_IMPORT_RE)) {
    const up = '../'.repeat(match[1]!.length - 1);
    const base = joinRelative(dirOf(fromPath), up || '.');
    if (base === null) continue;
    const modules = match[2]
      ? [match[2].replace(/\./g, '/')]
      : match[3]!.replace(/[()]/g, '').split(',').map((n) => n.trim().split(/\s+/)[0] ?? '').filter(Boolean);
    for (const module of modules) {
      const target = base ? `${base}/${module}` : module;
      groups.push([`${target}.py`, `${target}/__init__.py`]);
    }
  }
  return groups;
}

interface PairLookup {
  candidates: string[];
  reason: string;
}

const inDir = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
const testsOf = (path: string, candidates: string[]): PairLookup => ({ candidates, reason: `test of ${path}` });
const implementationOf = (path: string, candidates: string[]): PairLookup => ({
  candidates: [...new Set(candidates)],
  reason: `implementation of the test ${path}`,
});
/** The parent of a test directory (`src/__tests__` → `src`), else the directory itself. */
const outOfTestDir = (dir: string, testDir: string): string => (dir.split('/').pop() === testDir ? dirOf(dir) : dir);

/** `x.ts` ↔ `x.test.ts`, `x.spec.ts`, `__tests__/x.test.ts` (any JS/TS extension). */
function jsPair(path: string, dir: string, stem: string, ext: string): PairLookup {
  const test = stem.match(/^(.*)\.(test|spec)$/);
  if (test) return implementationOf(path, [inDir(outOfTestDir(dir, '__tests__'), `${test[1]}.${ext}`)]);
  return testsOf(path, [inDir(dir, `${stem}.test.${ext}`), inDir(dir, `${stem}.spec.${ext}`), inDir(dir, `__tests__/${stem}.test.${ext}`)]);
}

/** `x.py` ↔ `test_x.py`, `x_test.py`, `tests/test_x.py`, in both directions. */
function pyPair(path: string, dir: string, stem: string): PairLookup {
  const tested = stem.startsWith('test_') ? stem.slice('test_'.length) : stem.endsWith('_test') ? stem.slice(0, -'_test'.length) : undefined;
  if (tested) {
    const name = `${tested}.py`;
    return implementationOf(path, [inDir(dir, name), inDir(outOfTestDir(dir, 'tests'), name)]);
  }
  return testsOf(path, [inDir(dir, `test_${stem}.py`), inDir(dir, `${stem}_test.py`), inDir(dir, `tests/test_${stem}.py`)]);
}

/** `x.go` ↔ `x_test.go`. */
function goPair(path: string, dir: string, stem: string): PairLookup {
  return stem.endsWith('_test')
    ? implementationOf(path, [inDir(dir, `${stem.slice(0, -'_test'.length)}.go`)])
    : testsOf(path, [inDir(dir, `${stem}_test.go`)]);
}

/** The sibling test of an implementation file, or the implementation of a test file. */
export function pairCandidates(path: string): PairLookup | undefined {
  const dir = dirOf(path);
  const ext = extOf(path);
  const stem = path.slice(dir ? dir.length + 1 : 0, -(ext.length + 1));
  if (JS_EXTENSIONS.has(ext)) return jsPair(path, dir, stem, ext);
  if (ext === 'py') return pyPair(path, dir, stem);
  if (ext === 'go') return goPair(path, dir, stem);
  return undefined;
}

/** The new side of a patch (added and context lines): the whole file when the file was added. */
function patchNewSide(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith(' '))
    .map((line) => line.slice(1))
    .join('\n');
}

/** Every import lookup of one reviewed file, from its head content. */
function importLookups(path: string, content: string): Lookup[] {
  const ext = extOf(path);
  const groups = JS_EXTENSIONS.has(ext)
    ? localImportSpecifiers(content).map((s) => resolveImportCandidates(path, s))
    : ext === 'py'
      ? pythonImportCandidates(path, content)
      : [];
  return groups
    .filter((candidates) => candidates.length > 0)
    .map((candidates) => ({ candidates, kind: 'import' as const, reason: `imported by ${path}`, forPath: path, disclose: true }));
}

/** Runs `fn` over the items, {@link READ_CONCURRENCY} at a time. */
async function inChunks<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    await Promise.all(items.slice(i, i + READ_CONCURRENCY).map(fn));
  }
}

/**
 * A read's content (null when the path does not exist), or why it was not read. The content is
 * wrapped so a file whose text is literally "limit" or "failed" is never taken for a sentinel.
 */
type ReadOutcome = { content: string | null } | 'limit' | 'failed';

/** Runs lookups a few at a time within the read limit; returns the files found. */
class ContextReader {
  private reads = 0;
  private readonly attempted = new Map<string, Promise<ReadOutcome>>();
  readonly found: RepositoryContextFile[] = [];
  readonly leftOut: string[] = [];

  constructor(
    private readonly client: GitHubClient,
    private readonly params: GatherContextParams,
    /** Reviewed files with their head content: a lookup that lands on one needs no read. */
    readonly known: Map<string, string | null>,
  ) {}

  /** A path several reviewed files import is read, and counted against the limit, once. */
  read(path: string): Promise<ReadOutcome> {
    let outcome = this.attempted.get(path);
    if (!outcome) {
      outcome = this.readOnce(path);
      this.attempted.set(path, outcome);
    }
    return outcome;
  }

  private async readOnce(path: string): Promise<ReadOutcome> {
    if (this.reads >= MAX_CONTEXT_READS) return 'limit';
    this.reads++;
    try {
      return { content: await readAtRef(this.client, this.params.owner, this.params.repo, this.params.headSha, path) };
    } catch {
      // A failed read (rate limit, 5xx) leaves one context file out; it is counted, never fatal.
      this.leftOut.push(`${path} (could not be read)`);
      return 'failed';
    }
  }

  async run(lookups: readonly Lookup[]): Promise<void> {
    await inChunks(lookups, (lookup) => this.lookUp(lookup));
  }

  /** a: the full version of a changed file, recorded in `known` for the later lookups. */
  async readChangedFile(file: ReviewedFile): Promise<void> {
    const outcome = await this.read(file.path);
    if (outcome === 'limit') this.leftOut.push(`${file.path} (not looked up)`);
    const content = typeof outcome === 'object' ? outcome.content : null;
    const full = content !== null ? capFileContent(content) : null;
    if (full) this.add({ kind: 'changed-file', reason: 'changed file, full version', forPath: file.path }, file.path, full);
    this.known.set(file.path, full);
  }

  private async lookUp(lookup: Lookup): Promise<void> {
    for (const path of lookup.candidates) {
      if (path === lookup.forPath) return;
      if (this.known.has(path)) {
        const content = this.known.get(path);
        if (content) this.add(lookup, path, content);
        return; // a reviewed file: its own entry (or its patch) already covers it
      }
      // A sensitive name (`./.env` → `.env.ts`, `.env/index.ts`) ends the lookup: no form of it is
      // read. Any other candidate context may not hold (excluded, generated) is skipped, and a later
      // candidate of the same lookup may still be fine.
      if (isSensitivePath(path) || isSensitivePath(lookup.candidates[0] ?? path)) return;
      if (!isContextPathAllowed(path, { exclude: this.params.exclude, isSensitivePath })) continue;
      const outcome = await this.read(path);
      if (outcome === 'limit') {
        if (lookup.disclose) this.leftOut.push(`${lookup.candidates[0]} (not looked up)`);
        return;
      }
      if (outcome === 'failed') return;
      if (outcome.content !== null) {
        this.add(lookup, path, capFileContent(outcome.content));
        return;
      }
    }
  }

  add(lookup: Pick<Lookup, 'kind' | 'reason' | 'forPath'>, path: string, content: string): void {
    this.found.push({ path, content, reason: lookup.reason, kind: lookup.kind, forPaths: [lookup.forPath] });
  }
}

/**
 * Reads the repository context of the reviewed files at the PR head, in priority order: each
 * changed file's full version, then sibling tests/implementations, then local imports. An added
 * file is not read (its patch is the whole file). The engine fits what is returned to
 * `review.contextTokens`; reads are capped at {@link MAX_CONTEXT_READS} and shared per client.
 */
export async function gatherRepositoryContext(client: GitHubClient, params: GatherContextParams): Promise<GatheredContext> {
  if (params.contextTokens <= 0) return { files: [], leftOut: [] };
  const reviewed = params.files.filter(
    (f) => classifyFile(f, { exclude: params.exclude, isSensitivePath }) === 'review',
  );
  // An added file is never read: its patch is the whole file. That content still serves as the
  // import context of a reviewed file in another batch (the engine skips it within its own batch).
  const added = reviewed.filter((f) => f.status === 'added').map((f): [string, string] => [f.path, patchNewSide(f.patch ?? '')]);
  const reader = new ContextReader(client, params, new Map<string, string | null>(added));
  // a: the full version of each changed file that context may hold (not vendor, out/, lockfiles…),
  // so such files do not use up the read limit before the engine would drop them anyway.
  const readable = reviewed.filter(
    (f) => f.status !== 'added' && isContextPathAllowed(f.path, { exclude: params.exclude, isSensitivePath }),
  );
  await inChunks(readable, (file) => reader.readChangedFile(file));

  // c, then b: sibling tests/implementations, then local imports (from the head content or patch).
  const pairs = reviewed.flatMap((file): Lookup[] => {
    const pair = pairCandidates(file.path);
    return pair ? [{ ...pair, kind: 'test-pair', forPath: file.path, disclose: false }] : [];
  });
  const imports = reviewed.flatMap((file) =>
    importLookups(file.path, reader.known.get(file.path) ?? patchNewSide(file.patch ?? '')),
  );
  await reader.run([...pairs, ...imports]);
  return { files: reader.found, leftOut: reader.leftOut };
}

/** The summary's context line: what the engine sent and left out, plus what the gatherer could not read. */
export function contextDisclosureOf(
  engine: ContextDisclosure | undefined,
  gathererLeftOut: readonly string[],
): ContextDisclosure | undefined {
  if (!engine && gathererLeftOut.length === 0) return undefined;
  return { sent: engine?.sent ?? [], leftOut: [...(engine?.leftOut ?? []), ...gathererLeftOut] };
}
