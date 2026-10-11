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

export interface GetFileContentParams {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export type CompareCommitsStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface CompareCommitsParams {
  owner: string;
  repo: string;
  base: string;
  head: string;
}

export interface CompareCommitsResult {
  status: CompareCommitsStatus;
  files: GitHubPullRequestFile[];
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
}

export interface GitHubCreatedIssue {
  id: number;
  number: number;
  html_url?: string;
}

export interface GitHubClient {
  listPullRequestFilesPage(params: ListFilesPageParams): Promise<GitHubPullRequestFile[]>;
  getPullRequest(params: GetPullRequestParams): Promise<GitHubPullRequest>;
  listReviewsPage(params: ListReviewsPageParams): Promise<GitHubReview[]>;
  createReview(params: CreateReviewParams): Promise<GitHubCreatedReview>;
  getFileContent(params: GetFileContentParams): Promise<string | null>;
  compareCommits(params: CompareCommitsParams): Promise<CompareCommitsResult | null>;
  createIssue?(params: CreateIssueParams): Promise<GitHubCreatedIssue>;
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
          const encoding = item.encoding ?? 'base64';
          if (encoding === 'base64') {
            return Buffer.from(item.content, 'base64').toString('utf8');
          }
          return item.content;
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

      async compareCommits(params: CompareCommitsParams): Promise<CompareCommitsResult | null> {
        try {
          const PAGE_SIZE = 100;
          let page = 1;
          let status: CompareCommitsStatus = 'identical';
          const allFiles: GitHubPullRequestFile[] = [];

          while (true) {
            const response = await octokit.rest.repos.compareCommitsWithBasehead({
              owner: params.owner,
              repo: params.repo,
              basehead: `${params.base}...${params.head}`,
              page,
              per_page: PAGE_SIZE,
            });

            status = response.data.status as CompareCommitsStatus;
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
    };
  } catch (error) {
    sanitizeError(error, token);
  }
}
