import { DEFAULT_MAX_RULES_TOKENS, estimateTokens } from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import { capFileContent, type FileContent } from './contents.js';
import { readAtRef } from './read-cache.js';

/** The rules files looked up in the directories of the changed files (ADR-0028). */
export const NESTED_RULES_NAMES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];

/** At most this many directories are looked up (two reads each); the rest are disclosed. */
export const MAX_RULES_DIRECTORIES = 40;

/** Reads run this many at a time, to stay clear of GitHub's secondary rate limits. */
const READ_CONCURRENCY = 8;

export interface NestedRulesParams {
  owner: string;
  repo: string;
  /** The base commit: owner rules never come from the PR head. */
  baseSha: string;
  /** The configured rules files, already read from the base commit; always kept. */
  rulesFiles: readonly FileContent[];
  /** The files this review covers. */
  changedPaths: readonly string[];
  /** `review.maxRulesTokens`; defaults to 12,000. */
  maxRulesTokens?: number | undefined;
}

export interface NestedRulesResult {
  /** The configured rules files followed by the nested ones that fit, shallowest first. */
  rulesFiles: FileContent[];
  /** Nested rules the review could not include, for the summary: never dropped silently. */
  leftOut: string[];
}

/** The directories above a path, deepest first, without the repository root. */
export function ancestorDirectories(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/'));
}

const depthOf = (path: string): number => path.split('/').length;

/** Reads the candidate paths at the base commit, a few at a time; unreadable ones go to `leftOut`. */
async function readCandidates(
  client: GitHubClient,
  params: NestedRulesParams,
  candidates: readonly string[],
  leftOut: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + READ_CONCURRENCY).map(async (path) => {
        try {
          const content = await readAtRef(client, params.owner, params.repo, params.baseSha, path);
          if (content !== null) found.set(path, capFileContent(content));
        } catch {
          // Any read failure (rate limit, 5xx, permissions) leaves one optional rules file out; it is
          // named in the summary rather than failing the whole review or being dropped silently.
          leftOut.push(`${path} (could not be read)`);
        }
      }),
    );
  }
  return found;
}

/**
 * For each changed file, every found rules file in any of its directories: a broader
 * `apps/AGENTS.md` still applies under `apps/api/` next to `apps/api/AGENTS.md`.
 */
function applicableRules(changedPaths: readonly string[], found: ReadonlyMap<string, string>): FileContent[] {
  const applicable = new Set<string>();
  for (const changed of changedPaths) {
    for (const dir of ancestorDirectories(changed)) {
      for (const name of NESTED_RULES_NAMES) {
        if (found.has(`${dir}/${name}`)) applicable.add(`${dir}/${name}`);
      }
    }
  }
  return [...applicable].map((path) => ({ path, content: found.get(path)! }));
}

/** Keeps the nested files that fit next to the configured ones, shallowest then smallest first. */
function fitUnderCap(configured: readonly FileContent[], nested: FileContent[], maxTokens: number, leftOut: string[]): FileContent[] {
  let used = configured.reduce((sum, f) => sum + estimateTokens(f.content), 0);
  const kept: FileContent[] = [];
  nested.sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.content.length - b.content.length || (a.path < b.path ? -1 : 1));
  for (const file of nested) {
    const tokens = estimateTokens(file.content);
    if (used + tokens <= maxTokens) {
      kept.push(file);
      used += tokens;
    } else {
      leftOut.push(file.path);
    }
  }
  return kept;
}

/**
 * Adds, for every changed file, each AGENTS.md and CLAUDE.md in its own directories (e.g.
 * `apps/AGENTS.md` and `apps/api/AGENTS.md`), read from the base commit, deduplicated against the
 * configured rules files.
 * The configured files always go; nested ones fill what is left of `maxRulesTokens`, shallowest and
 * smallest first. Everything left out (over the cap, past the directory limit, or unreadable) is
 * returned in `leftOut` for the summary.
 */
export async function withNestedRulesFiles(client: GitHubClient, params: NestedRulesParams): Promise<NestedRulesResult> {
  const configured = new Set(params.rulesFiles.map((f) => f.path));
  const leftOut: string[] = [];

  const directories = [...new Set(params.changedPaths.flatMap(ancestorDirectories))].sort((a, b) => depthOf(a) - depthOf(b));
  for (const dir of directories.slice(MAX_RULES_DIRECTORIES)) leftOut.push(`${dir}/ (not looked up)`);
  const candidates = directories
    .slice(0, MAX_RULES_DIRECTORIES)
    .flatMap((dir) => NESTED_RULES_NAMES.map((name) => `${dir}/${name}`))
    .filter((path) => !configured.has(path));

  const found = await readCandidates(client, params, candidates, leftOut);
  const nested = fitUnderCap(
    params.rulesFiles,
    applicableRules(params.changedPaths, found),
    params.maxRulesTokens ?? DEFAULT_MAX_RULES_TOKENS,
    leftOut,
  );
  return { rulesFiles: [...params.rulesFiles, ...nested], leftOut };
}
