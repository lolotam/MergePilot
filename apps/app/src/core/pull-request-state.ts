/** The PR fields a retry or a `@mergepilot review` request reads beyond the typed client shape. */
export interface PullRequestDetails {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  head: { sha: string };
  base?: { sha: string };
}

/** A closed or merged PR is never reviewed again, from the dashboard or from a comment. */
export function isPrClosedOrMerged(pr: unknown): boolean {
  const details = pr as PullRequestDetails;
  return details.state === 'closed' || Boolean(details.merged) || Boolean(details.merged_at);
}
