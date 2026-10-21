/**
 * The files a change cites (ADR-0041): explicit paths, ADR ids and spec ids named on the added
 * lines of a reviewed file, on the context lines around a change, or in the pull request
 * description. The scan only names candidate paths: each of them still passes the usual allow,
 * sensitive and exclude checks before anything is read.
 *
 * The pull request description is untrusted: it may only name candidate paths, never a URL, and
 * it is capped before it is scanned.
 */
import { isContextPathAllowed, isSensitivePath, type ContextKind } from '@mergepilot/engine';
import { isCitedPath } from './cited-path.js';
import type { ReviewedFile } from './review-context.js';

/** At most this many distinct cited paths are looked up per review. */
export const MAX_CITED_LOOKUPS = 20;

/** The pull request description is scanned for citations up to this many characters. */
export const MAX_PR_BODY_CITATION_CHARS = 4_000;

/** One thing to look up for a reviewed file: candidate paths in order, the first that exists wins. */
export interface Lookup {
  candidates: string[];
  kind: ContextKind;
  reason: string;
  forPath: string;
  /** The reviewed files it serves when more than `forPath` (a PR-description citation serves all). */
  forPaths?: string[] | undefined;
  /** Named in the summary when the read limit stops it (a speculative test lookup is not). */
  disclose: boolean;
  /** Keeps a found file only when its content passes (a workflow that runs the changed scripts). */
  accept?: (content: string) => boolean;
}

/** What the citation scan needs from the gatherer: a directory listing and the left-out list. */
export interface CitationReader {
  list(dir: string): Promise<string[]>;
  leftOut: string[];
}

/** Extensions of a documentation file: it may name the code file it talks about. */
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc']);
/** Extensions of a code file: a documentation file may name it. */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs',
  'java', 'kt', 'rb', 'php', 'cs', 'swift', 'sql',
]);

/**
 * An ADR id, a spec id or a repository path: `ADR-0029`, `spec 012`, `docs/adr/0029-…md`. The
 * path part refuses member expressions, calls and URLs through its look-behind.
 */
const CITATION_RE = /\bADR[- ](\d{4})\b|\b[Ss]pecs?[- /#]{0,2}(\d{3})(?!\d)|(?<![\p{L}\p{N}_./:\\@-])([\p{L}\p{N}_.@()[\]-]+(?:\/[\p{L}\p{N}_.@()[\]-]+)*\.[a-zA-Z]\w*)(?![\w/])/gu;

/** Where a scanned text comes from, so the kind and reason of a lookup say what named it. */
type CitationSource =
  | { kind: 'added-line'; file: ReviewedFile }
  | { kind: 'context-line'; file: ReviewedFile }
  | { kind: 'pr-body' };

/** The lower-case extension of a path, without its dot. */
const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  return base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
};

/** Whether a listed directory is the folder of a spec id (`docs/specs/012-pay/`). */
function isSpecDirOf(dir: string, id: string): boolean {
  if (!dir.endsWith('/')) return false;
  const name = dir.split('/').filter(Boolean).pop() ?? '';
  return name.startsWith(`${id}-`);
}

/** The kind and reason of a lookup: what named the file (ADR-0041). */
function citationKind(source: CitationSource, path: string): { kind: ContextKind; reason: string } {
  if (source.kind === 'pr-body') {
    return { kind: 'referenced', reason: 'cited by the pull request description' };
  }
  const file = source.file;
  // A changed document naming a code file: the code is what the document is about.
  if (DOC_EXTENSIONS.has(extensionOf(file.path)) && CODE_EXTENSIONS.has(extensionOf(path))) {
    return { kind: 'referenced', reason: `named in ${file.path}` };
  }
  if (source.kind === 'context-line') {
    return { kind: 'referenced', reason: `named near the change in ${file.path}` };
  }
  return { kind: 'cited', reason: `cited by ${file.path}` };
}

/** The added and the context lines of a patch, after its first hunk header. */
function hunkLines(patch: string): { added: string; context: string } {
  const added: string[] = [];
  const context: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) inHunk = true;
    if (!inHunk) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith(' ')) context.push(line.slice(1));
  }
  return { added: added.join('\n'), context: context.join('\n') };
}

/**
 * The lookups of the files a change cites (ADR-0041): the paths, ADR ids and spec ids named on
 * the added lines of the reviewed files, then on their context lines, then in the pull request
 * description. The strongest source comes first, so the lookup limit goes to it.
 */
export async function citedLookups(
  reader: CitationReader,
  reviewed: readonly ReviewedFile[],
  exclude: string[],
  prBody?: string | null,
): Promise<Lookup[]> {
  const lookups: Lookup[] = [];
  const selected = new Set<string>();
  const omitted = new Set<string>();
  let adrs: string[] | undefined;
  let specs: string[] | undefined;
  let rootFiles: Set<string> | undefined;

  /** Scans one text and pushes the lookups it names; `source` says what named them. */
  const scan = async (text: string, source: CitationSource): Promise<void> => {
    for (const match of text.matchAll(CITATION_RE)) {
      const adrId = match[1];
      const specId = match[2];
      const rawPath = match[3];
      let candidates: string[];
      if (adrId !== undefined) {
        if (adrs === undefined) adrs = (await reader.list('docs/adr')).sort();
        candidates = adrs.filter((path) => path.startsWith(`docs/adr/${adrId}-`) && path.endsWith('.md'));
      } else if (specId !== undefined) {
        if (specs === undefined) specs = (await reader.list('docs/specs')).sort();
        candidates = specs.filter((dir) => isSpecDirOf(dir, specId)).map((dir) => `${dir}spec.md`);
      } else {
        // A member call (`response.json()`) is not a path.
        if (text[match.index + match[0].length] === '(') continue;
        let path = rawPath!.split('](').pop()!;
        // Markdown's opening link punctuation is not part of a path; route groups stay intact.
        for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
          while (path.startsWith(open) && path.split(open).length > path.split(close).length) path = path.slice(1);
        }
        candidates = isCitedPath(path) ? [path] : [];
      }
      for (const path of candidates) {
        if (!isContextPathAllowed(path, { exclude, isSensitivePath })) continue;
        if (!selected.has(path) && selected.size >= MAX_CITED_LOOKUPS) {
          if (!omitted.has(path) && (path.includes('/') || rootFiles?.has(path))) {
            omitted.add(path);
            reader.leftOut.push(`${path} (cited lookup limit)`);
          }
          continue;
        }
        if (!path.includes('/')) {
          rootFiles ??= new Set(await reader.list(''));
          if (!rootFiles.has(path)) continue;
        }
        selected.add(path);
        const { kind, reason } = citationKind(source, path);
        lookups.push({
          candidates: [path],
          kind,
          reason,
          forPath: source.kind === 'pr-body' ? reviewed[0]!.path : source.file.path,
          ...(source.kind === 'pr-body' ? { forPaths: reviewed.map((f) => f.path) } : {}),
          disclose: true,
        });
      }
    }
  };

  const patches = reviewed.map((file) => ({ file, lines: hunkLines(file.patch ?? '') }));
  // a: the added lines of every reviewed file, in file order.
  for (const { file, lines } of patches) await scan(lines.added, { kind: 'added-line', file });
  // b: the context lines around the change, in file order.
  for (const { file, lines } of patches) await scan(lines.context, { kind: 'context-line', file });
  // c: the pull request description: untrusted, capped, and only a source of candidate paths.
  if (reviewed.length > 0) {
    await scan((prBody ?? '').slice(0, MAX_PR_BODY_CITATION_CHARS), { kind: 'pr-body' });
  }
  return lookups;
}
