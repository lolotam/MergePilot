import { findActiveRun } from './memory-runs.js';
import type { ApiEquivalentRunRow, ReviewRun } from './types.js';

/**
 * The rows the API-equivalent card prices (ADR-0047): the workspace's retained runs with a result
 * that ran on one of `providers` or carry a stored equivalent, as the Postgres query selects them.
 */
export function memoryApiEquivalentRows(
  runs: ReadonlyMap<string, ReviewRun>,
  workspaceId: string,
  providers: readonly string[],
): ApiEquivalentRunRow[] {
  return [...runs.values()]
    .filter((run) => run.workspaceId === workspaceId && run.result != null)
    .filter((run) => (run.provider != null && providers.includes(run.provider))
      || run.result?.pricing?.apiEquivalentUsd !== undefined
      || run.result?.pricing?.subscriptionPart !== undefined)
    .map((run) => ({
      createdAt: run.createdAt,
      provider: run.provider ?? null,
      model: run.model ?? null,
      pricing: run.result?.pricing ?? null,
      usage: run.result?.usage ?? null,
      judgeUsage: run.result?.judge
        ? { inputTokens: run.result.judge.inputTokens, outputTokens: run.result.judge.outputTokens }
        : null,
      fallbackFromMethod: run.result?.fallbackFromMethod ?? null,
    }));
}

/** The repositories the workspace has reviewed. */
export function memoryRunRepos(runs: ReadonlyMap<string, ReviewRun>, workspaceId: string): string[] {
  const repos = new Set<string>();
  for (const r of runs.values()) {
    if (r.workspaceId === workspaceId && r.repoFullName) {
      repos.add(r.repoFullName);
    }
  }
  return [...repos].sort();
}

/** The queued or running run of one PR head, when there is one. */
export function memoryActiveRun(
  runs: ReadonlyMap<string, ReviewRun>,
  workspaceId: string,
  repoFullName: string,
  pullNumber: number,
  headSha: string,
  botSlot?: number,
): ReviewRun | null {
  const run = findActiveRun(runs.values(), { workspaceId, repoFullName, pullNumber, headSha, botSlot });
  return run ? { ...run } : null;
}
