import type { GitHubClient } from '@mergepilot/github';
import { WorkspaceDeletedError, type AppStore } from '../core/types.js';

/**
 * Wraps the GitHub client so every write (review, issue) first re-checks that the installation is
 * still linked to the workspace the job started with. A workspace deleted mid-review therefore
 * never gets a review published on its behalf.
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
  const createIssue = client.createIssue?.bind(client);
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
    ...(createIssue
      ? {
          createIssue: async (params: Parameters<typeof createIssue>[0]) => {
            await ensureStillLinked();
            return createIssue(params);
          },
        }
      : {}),
  };
}
