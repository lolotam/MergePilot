import { Octokit } from '@octokit/rest';

import type {
  AddLabelsParams,
  CompareCommitsParams,
  CompareCommitsResult,
  CompareCommitsStatus,
  CreateIssueCommentParams,
  CreateIssueParams,
  CreateReviewParams,
  GetCollaboratorPermissionParams,
  GetFileContentParams,
  GetPullRequestParams,
  GitHubClient,
  GitHubCollaboratorPermission,
  GitHubCreatedIssue,
  GitHubCreatedReview,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubReview,
  GitHubReviewComment,
  GitHubReviewThread,
  ListFilesPageParams,
  ListIssueCommentsParams,
  ListReviewCommentsParams,
  ListReviewsPageParams,
  ListReviewThreadsParams,
  RemoveLabelParams,
} from './client-types.js';
import { directoryFilesOf, isNotFoundError } from './contents.js';
import { fetchReviewThreads } from './review-threads.js';

export * from './client-types.js';


function redactToken(str: string, token: string): string {
  if (!token) {
    return str;
  }
  return str.replaceAll(token, '[REDACTED]');
}

function sanitizeError(error: unknown, token: string): never {
  if (!token) {
    throw error;
  }

  if (error instanceof Error) {
    error.message = redactToken(error.message, token);
    if (error.stack) {
      error.stack = redactToken(error.stack, token);
    }
    if (error.cause instanceof Error) {
      error.cause.message = redactToken(error.cause.message, token);
    }
    throw error;
  }

  if (typeof error === 'string') {
    throw new Error(redactToken(error, token));
  }

  throw error;
}

/**
 * Creates a GitHubClient implementation backed by @octokit/rest, ensuring tokens are redacted from errors.
 */
export function createOctokitClient(token: string): GitHubClient {
  try {
    const octokit = new Octokit({ auth: token });

    return {
      async listPullRequestFilesPage(params: ListFilesPageParams): Promise<GitHubPullRequestFile[]> {
        try {
          const response = await octokit.rest.pulls.listFiles({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pull_number,
            page: params.page,
            per_page: params.per_page,
          });
          return response.data as GitHubPullRequestFile[];
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async getPullRequest(params: GetPullRequestParams): Promise<GitHubPullRequest> {
        try {
          const response = await octokit.rest.pulls.get({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pull_number,
          });
          return response.data as GitHubPullRequest;
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async listReviewsPage(params: ListReviewsPageParams): Promise<GitHubReview[]> {
        try {
          const response = await octokit.rest.pulls.listReviews({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pull_number,
            ...(params.page !== undefined ? { page: params.page } : {}),
            ...(params.per_page !== undefined ? { per_page: params.per_page } : {}),
          });
          return response.data as GitHubReview[];
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async createReview(params: CreateReviewParams): Promise<GitHubCreatedReview> {
        try {
          const response = await octokit.rest.pulls.createReview({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pull_number,
            commit_id: params.commit_id,
            body: params.body,
            event: params.event,
            ...(params.comments ? { comments: params.comments } : {}),
          });
          return { id: response.data.id };
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async getFileContent(params: GetFileContentParams): Promise<string | null> {
        try {
          const response = await octokit.rest.repos.getContent({
            owner: params.owner,
            repo: params.repo,
            path: params.path,
            ref: params.ref,
          });
          const data = response.data;
          if (Array.isArray(data) || !data || typeof data !== 'object') {
            return null;
          }
          const item = data as { type?: string; content?: string; encoding?: string };
          if (item.type !== 'file' || typeof item.content !== 'string') {
            return null;
          }
          // A file over 1 MB comes back with the encoding "none" and no content at all.
          if (item.encoding === 'none') {
            return null;
          }
          const encoding = item.encoding ?? 'base64';
          if (encoding === 'base64') {
            return Buffer.from(item.content, 'base64').toString('utf8');
          }
          return item.content;
        } catch (error: unknown) {
          if (isNotFoundError(error)) return null;
          sanitizeError(error, token);
        }
      },

      async listDirectoryFiles(params: GetFileContentParams): Promise<string[] | null> {
        try {
          const response = await octokit.rest.repos.getContent({
            owner: params.owner,
            repo: params.repo,
            path: params.path,
            ref: params.ref,
          });
          return directoryFilesOf(response.data);
        } catch (error: unknown) {
          if (isNotFoundError(error)) return null;
          sanitizeError(error, token);
        }
      },

      async listTreePaths(params: { owner: string; repo: string; ref: string }): Promise<string[] | null> {
        try {
          const response = await octokit.rest.git.getTree({
            owner: params.owner,
            repo: params.repo,
            tree_sha: params.ref,
            recursive: 'true',
          });
          const tree = Array.isArray(response.data.tree) ? response.data.tree : [];
          // A truncated tree still holds what the API returned; the rest is simply not listed.
          return tree.flatMap((entry) =>
            entry.type === 'blob' && typeof entry.path === 'string' ? [entry.path] : [],
          );
        } catch (error: unknown) {
          if (isNotFoundError(error)) return null;
          sanitizeError(error, token);
        }
      },

      async compareCommits(params: CompareCommitsParams): Promise<CompareCommitsResult | null> {
        try {
          const PAGE_SIZE = 100;
          let page = 1;
          let status: CompareCommitsStatus = 'identical';
          const allFiles: GitHubPullRequestFile[] = [];

          let totalCommits: number | undefined;
          // The merge base comes with the first page only.
          let mergeBaseSha: string | undefined;

          while (true) {
            const response = await octokit.rest.repos.compareCommitsWithBasehead({
              owner: params.owner,
              repo: params.repo,
              basehead: `${params.base}...${params.head}`,
              page,
              per_page: PAGE_SIZE,
            });

            status = response.data.status as CompareCommitsStatus;
            if (response.data.total_commits !== undefined) {
              totalCommits = response.data.total_commits;
            }
            if (page === 1) {
              mergeBaseSha = response.data.merge_base_commit?.sha;
            }
            const pageFiles = (response.data.files ?? []) as GitHubPullRequestFile[];
            allFiles.push(...pageFiles);

            if (pageFiles.length < PAGE_SIZE) {
              break;
            }
            page++;
          }

          return {
            status,
            files: allFiles,
            ...(totalCommits !== undefined ? { totalCommits } : {}),
            ...(mergeBaseSha !== undefined ? { mergeBaseSha } : {}),
          };
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            (error as { status: unknown }).status === 404
          ) {
            return null;
          }
          sanitizeError(error, token);
        }
      },

      async createIssue(params: CreateIssueParams): Promise<GitHubCreatedIssue> {
        try {
          const response = await octokit.rest.issues.create({
            owner: params.owner,
            repo: params.repo,
            title: params.title,
            body: params.body,
          });
          return {
            id: response.data.id,
            number: response.data.number,
            html_url: response.data.html_url,
          };
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async listReviewCommentsPage(params: ListReviewCommentsParams): Promise<GitHubReviewComment[]> {
        try {
          const response = await octokit.rest.pulls.listReviewComments({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pull_number,
            ...(params.page !== undefined ? { page: params.page } : {}),
            ...(params.per_page !== undefined ? { per_page: params.per_page } : {}),
          });
          return response.data as GitHubReviewComment[];
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async listReviewThreads(params: ListReviewThreadsParams): Promise<GitHubReviewThread[]> {
        try {
          return await fetchReviewThreads((query, variables) => octokit.graphql(query, variables), params);
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async listIssueCommentsPage(params: ListIssueCommentsParams): Promise<GitHubIssueComment[]> {
        try {
          const response = await octokit.rest.issues.listComments({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issue_number,
            ...(params.page !== undefined ? { page: params.page } : {}),
            ...(params.per_page !== undefined ? { per_page: params.per_page } : {}),
          });
          return response.data as GitHubIssueComment[];
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async createIssueComment(params: CreateIssueCommentParams): Promise<{ id: number }> {
        try {
          const response = await octokit.rest.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issue_number,
            body: params.body,
          });
          return { id: response.data.id };
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async addLabels(params: AddLabelsParams): Promise<void> {
        try {
          await octokit.rest.issues.addLabels({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issue_number,
            labels: params.labels,
          });
        } catch (error) {
          sanitizeError(error, token);
        }
      },

      async removeLabel(params: RemoveLabelParams): Promise<void> {
        try {
          await octokit.rest.issues.removeLabel({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issue_number,
            name: params.name,
          });
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            (error as { status: unknown }).status === 404
          ) {
            return;
          }
          sanitizeError(error, token);
        }
      },

      async getCollaboratorPermission(params: GetCollaboratorPermissionParams): Promise<GitHubCollaboratorPermission> {
        try {
          const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: params.owner,
            repo: params.repo,
            username: params.username,
          });
          return { permission: response.data.permission };
        } catch (error) {
          sanitizeError(error, token);
        }
      },
    };
  } catch (error) {
    sanitizeError(error, token);
  }
}
