/**
 * The requests of one exploration round (ADR-0046): what the model may ask the engine to read,
 * search or list. One request is exactly one of `read`, `find` or `list`, so an answer cannot
 * smuggle a second action into one request, and every path goes through the same rules: no
 * traversal, no absolute path, no `.git`, and only the paths the review's own rules allow.
 *
 * The content that comes back is untrusted data from the repository: the caller escapes and
 * redacts it before it reaches a prompt.
 */

import { z } from 'zod';
import type { ExploreLimits } from '../config/schema.js';
import { estimateTokens } from './budget.js';
import type { ExploreBudget, RepositoryReader } from './explore.js';

/** Lines of a file at the PR head, 1-based and inclusive. */
export const ExploreReadSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

/** A literal, case-sensitive search in the files this review holds and in the head's paths. */
export const ExploreFindSchema = z.strictObject({
  text: z.string().min(1).max(200),
  /** Only the paths that start with it are searched. */
  path: z.string().optional(),
});

/** The files of one directory at the PR head. */
export const ExploreListSchema = z.strictObject({
  dir: z.string().min(1),
});

/** One request: exactly one of the three kinds. */
export const ExploreRequestSchema = z.union([
  z.strictObject({ read: ExploreReadSchema }),
  z.strictObject({ find: ExploreFindSchema }),
  z.strictObject({ list: ExploreListSchema }),
]);

export type ExploreRequest = z.infer<typeof ExploreRequestSchema>;

/** The answer of an exploration round: the requests, or an empty list when nothing more is needed. */
export const ExploreAnswerSchema = z.object({
  explore: z.array(ExploreRequestSchema).max(20),
});


/** The JSON schema of the exploration answer, sent with the request. */
export const exploreJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(ExploreAnswerSchema) as Record<string, unknown>;

/** At most this many matches of one search are returned. */
export const MAX_FIND_MATCHES = 50;
/** At most this many entries of one directory listing are returned. */
export const MAX_LIST_ENTRIES = 200;
/** What a refused request says. */
export const REFUSED_CONTENT = 'not allowed';
/** What a request says when the read budget of the review is used up. */
export const BUDGET_USED_UP = 'read budget used up';
/** What a request says when the reader failed (network, rate limit, a server error). */
export const READ_FAILED_CONTENT = 'read failed';
/** The note a read cut to the remaining budget carries. */
export const BUDGET_CUT_NOTE = '… (cut to the read budget)';

/** One result of a request, as the exploration block shows it. */
export interface ExploreEntry {
  label: string;
  content: string;
}

export interface ExecuteRequestsContext {
  reader: RepositoryReader;
  budget: ExploreBudget;
  limits: ExploreLimits;
  /** Whether a path may be read (the review's own skip rules). */
  allowPath: (path: string) => boolean;
  /** The files this review already holds: the patches and the context files. */
  heldTexts: ReadonlyMap<string, string>;
}

export interface ExecuteRequestsResult {
  entries: ExploreEntry[];
  refused: number;
}

/** The path of a request, normalized to the repository's own form. */
export function normalizeExplorePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The path rules of every request (ADR-0046): no empty path, no absolute path, no traversal
 * segment and nothing under `.git`.
 */
export function isUnsafeExplorePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  if (path.split('/').some((segment) => segment === '..')) return true;
  if (path === '.git' || path.startsWith('.git/')) return true;
  return false;
}

/** A path of a directory listing: a file is checked as it is, a directory with a name under it. */
function isAllowedEntry(entry: string, allowPath: (path: string) => boolean): boolean {
  return entry.endsWith('/') ? allowPath(`${entry}x`) : allowPath(entry);
}

/** Cuts whole lines from the end until the text fits the remaining read budget. */
function cutToBudget(text: string, remainingTokens: number): { text: string; tokens: number } {
  const full = estimateTokens(text);
  if (full <= remainingTokens) return { text, tokens: full };
  let used = estimateTokens(`${BUDGET_CUT_NOTE}\n`);
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > remainingTokens) break;
    kept.push(line);
    used += cost;
  }
  const cut = kept.length > 0 ? `${kept.join('\n')}\n${BUDGET_CUT_NOTE}` : BUDGET_CUT_NOTE;
  return { text: cut, tokens: estimateTokens(cut) };
}

/** The lines of a file a read asks for, with their line numbers. */
function numberedLines(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
  maxLines: number,
): { text: string; start: number } {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  const selected = lines.slice(start - 1, Math.max(start - 1, end)).slice(0, maxLines);
  const text = selected.map((line, index) => `${start + index}| ${line}`).join('\n');
  return { text, start };
}

/**
 * The key of a read: the path and the range asked for. The same range of the same file is served
 * free; every other range is charged like a first read, so a one-line read does not buy the whole
 * file for nothing (ADR-0046).
 */
function servedKey(path: string, request: z.infer<typeof ExploreReadSchema>): string {
  return `${path}|${request.startLine ?? ''}|${request.endLine ?? ''}`;
}

/** The label a request shows in the block, also when it failed. */
function labelOf(request: ExploreRequest): string {
  if ('read' in request) return normalizeExplorePath(request.read.path);
  if ('find' in request) return `find: ${request.find.text}`;
  return `list: ${normalizeExplorePath(request.list.dir)}`;
}

/** One read: the lines of a file at the PR head, cut to the remaining read budget. */
async function executeRead(
  request: z.infer<typeof ExploreReadSchema>,
  ctx: ExecuteRequestsContext,
): Promise<{ entry: ExploreEntry; refused: boolean }> {
  const path = normalizeExplorePath(request.path);
  if (isUnsafeExplorePath(path) || !ctx.allowPath(path)) {
    return { entry: { label: `refused: ${path}`, content: REFUSED_CONTENT }, refused: true };
  }
  const cached = ctx.budget.readFiles.get(path);
  let content: string | null;
  if (cached === undefined) {
    content = await ctx.reader.readFile(path);
    ctx.budget.readFiles.set(path, content);
  } else {
    content = cached;
  }
  if (content === null) return { entry: { label: path, content: 'not found' }, refused: false };
  const { text, start } = numberedLines(content, request.startLine, request.endLine, ctx.limits.maxLinesPerRead);
  if (text.length === 0) return { entry: { label: path, content: 'no such lines' }, refused: false };
  const label = start === 1 ? path : `${path}:${start}`;
  ctx.budget.addFileRead(path);
  // The same range of a file that was served before is free; every other range of it is charged
  // and cut like a first read.
  const key = servedKey(path, request);
  if (ctx.budget.served(key)) return { entry: { label, content: text }, refused: false };
  const cut = cutToBudget(text, ctx.budget.remainingTokens);
  ctx.budget.charge(cut.tokens);
  ctx.budget.markServed(key);
  return { entry: { label, content: cut.text }, refused: false };
}

/** One search: the lines of the held files that hold the text, and the paths that name it. */
async function executeFind(
  request: z.infer<typeof ExploreFindSchema>,
  ctx: ExecuteRequestsContext,
): Promise<{ entry: ExploreEntry; refused: boolean }> {
  const label = `find: ${request.text}`;
  const prefix = request.path === undefined ? undefined : normalizeExplorePath(request.path);
  if (prefix !== undefined && isUnsafeExplorePath(prefix)) {
    return { entry: { label: `refused: ${prefix}`, content: REFUSED_CONTENT }, refused: true };
  }
  const sources = new Map<string, string>(ctx.heldTexts);
  for (const [path, text] of ctx.budget.readFiles) {
    if (text !== null) sources.set(path, text);
  }
  const matches: string[] = [];
  for (const [path, text] of sources) {
    if (prefix !== undefined && !path.startsWith(prefix)) continue;
    if (!ctx.allowPath(path)) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < MAX_FIND_MATCHES; index++) {
      const line = lines[index] ?? '';
      if (line.includes(request.text)) {
        matches.push(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`);
      }
    }
  }
  const paths = await ctx.budget.listPaths(ctx.reader);
  for (const path of paths ?? []) {
    if (matches.length >= MAX_FIND_MATCHES) break;
    if (!path.includes(request.text)) continue;
    if (prefix !== undefined && !path.startsWith(prefix)) continue;
    if (!ctx.allowPath(path)) continue;
    matches.push(path);
  }
  const content = matches.join('\n');
  const cut = cutToBudget(content, ctx.budget.remainingTokens);
  ctx.budget.charge(cut.tokens);
  return { entry: { label, content: cut.text }, refused: false };
}

/** One listing: the files of a directory at the PR head, the allowed ones only. */
async function executeList(
  request: z.infer<typeof ExploreListSchema>,
  ctx: ExecuteRequestsContext,
): Promise<{ entry: ExploreEntry; refused: boolean }> {
  const dir = normalizeExplorePath(request.dir);
  const label = `list: ${dir}`;
  if (isUnsafeExplorePath(dir) || !ctx.allowPath(`${dir}/x`)) {
    return { entry: { label: `refused: ${dir}`, content: REFUSED_CONTENT }, refused: true };
  }
  const entries = await ctx.reader.listDirectory(dir);
  if (entries === null) return { entry: { label, content: 'not found' }, refused: false };
  const allowed = entries.filter((entry) => isAllowedEntry(entry, ctx.allowPath)).slice(0, MAX_LIST_ENTRIES);
  const content = allowed.join('\n');
  const cut = cutToBudget(content, ctx.budget.remainingTokens);
  ctx.budget.charge(cut.tokens);
  return { entry: { label, content: cut.text }, refused: false };
}

/**
 * Runs the requests of one round: every request answers with an entry the exploration block
 * shows, and the refused ones say only that they were refused. A request the read budget cannot
 * pay for ends the round, and a reader that fails never fails the review: the request answers that
 * it failed, and the round goes on (ADR-0046).
 */
export async function executeRequests(
  requests: readonly ExploreRequest[],
  ctx: ExecuteRequestsContext,
): Promise<ExecuteRequestsResult> {
  const entries: ExploreEntry[] = [];
  let refused = 0;
  for (const request of requests) {
    if (ctx.budget.remainingTokens <= 0) {
      entries.push({ label: BUDGET_USED_UP, content: BUDGET_USED_UP });
      break;
    }
    let result: { entry: ExploreEntry; refused: boolean };
    try {
      result = 'read' in request
        ? await executeRead(request.read, ctx)
        : 'find' in request
          ? await executeFind(request.find, ctx)
          : await executeList(request.list, ctx);
    } catch {
      // A reader that fails (a network error, a rate limit, a server error) says nothing about the
      // review: the request answers that it failed, and the error text never reaches the prompt.
      result = { entry: { label: labelOf(request), content: READ_FAILED_CONTENT }, refused: false };
    }
    if (result.refused) refused += 1;
    entries.push(result.entry);
  }
  return { entries, refused };
}
