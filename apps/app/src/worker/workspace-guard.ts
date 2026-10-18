import type { GitHubClient } from '@mergepilot/github';
import { WorkspaceDeletedError, type AppStore } from '../core/types.js';

/**
 * Wraps the GitHub client so every write (review, issue, comment, label) first re-checks that the
 * installation is still linked to the workspace the job started with. A workspace deleted
 * mid-review therefore never gets anything published on its behalf. Reads pass straight through;
 * every optional method of the client is kept (dropping one silently disables dedupe and pause).
 */
export function guardWritesForWorkspace(
  client: GitHubClient,
  store: AppStore,
  installationId: number,
  workspaceId: string,
): GitHubClient {
  const ensureStillLinked = async (): Promise<void> => {
    const current = await store.getInstallation(installationId);
    if (!current || current.workspaceId !== workspaceId) {
      throw new WorkspaceDeletedError(workspaceId);
    }
  };
  const guarded = <P, R>(write: ((params: P) => Promise<R>) | undefined) =>
    write
      ? async (params: P): Promise<R> => {
          await ensureStillLinked();
          return write(params);
        }
      : undefined;
  const bind = <F extends (...args: never[]) => unknown>(fn: F | undefined): F | undefined =>
    fn ? (fn.bind(client) as F) : undefined;

  const optional = {
    listReviewCommentsPage: bind(client.listReviewCommentsPage),
    listReviewThreads: bind(client.listReviewThreads),
    listDirectoryFiles: bind(client.listDirectoryFiles),
    listIssueCommentsPage: bind(client.listIssueCommentsPage),
    getCollaboratorPermission: bind(client.getCollaboratorPermission),
    createIssue: guarded(bind(client.createIssue)),
    createIssueComment: guarded(bind(client.createIssueComment)),
    addLabels: guarded(bind(client.addLabels)),
    removeLabel: guarded(bind(client.removeLabel)),
  };

  return {
    listPullRequestFilesPage: (params) => client.listPullRequestFilesPage(params),
    getPullRequest: (params) => client.getPullRequest(params),
    listReviewsPage: (params) => client.listReviewsPage(params),
    getFileContent: (params) => client.getFileContent(params),
    compareCommits: (params) => client.compareCommits(params),
    createReview: async (params) => {
      await ensureStillLinked();
      return client.createReview(params);
    },
    ...Object.fromEntries(Object.entries(optional).filter(([, fn]) => fn !== undefined)),
  };
}
