import { Octokit } from '@octokit/rest';

export interface GitHubPullRequestFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
}

export interface GitHubPullRequest {
  head: {
    sha: string;
  };
}

export interface GitHubReview {
  id: number;
  body?: string | null;
  user?: { login: string } | null;
}

export interface GitHubDraftReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface ListFilesPageParams {
  owner: string;
  repo: string;
  pull_number: number;
  page: number;
  per_page: number;
}

export interface GetPullRequestParams {
  owner: string;
  repo: string;
  pull_number: number;
}

export interface ListReviewsPageParams {
  owner: string;
  repo: string;
  pull_number: number;
  page?: number;
  per_page?: number;
}

export interface CreateReviewParams {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  body: string;
  event: 'COMMENT';
  comments?: GitHubDraftReviewComment[];
}

export interface GitHubCreatedReview {
  id: number;
}

export interface GitHubClient {
  listPullRequestFilesPage(params: ListFilesPageParams): Promise<GitHubPullRequestFile[]>;
  getPullRequest(params: GetPullRequestParams): Promise<GitHubPullRequest>;
  listReviewsPage(params: ListReviewsPageParams): Promise<GitHubReview[]>;
  createReview(params: CreateReviewParams): Promise<GitHubCreatedReview>;
}

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
    };
  } catch (error) {
    sanitizeError(error, token);
  }
}
