import type {
  CompareCommitsParams,
  CompareCommitsResult,
  CompareCommitsStatus,
  CreateReviewParams,
  GetFileContentParams,
  GetPullRequestParams,
  GitHubClient,
  GitHubCreatedReview,
  GitHubDraftReviewComment,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubReview,
  ListFilesPageParams,
  ListReviewsPageParams,
} from '@mergepilot/github';

export interface OctokitLike {
  rest: {
    pulls: {
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        page?: number;
        per_page?: number;
      }): Promise<{ data: unknown[] }>;
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: unknown }>;
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        page?: number;
        per_page?: number;
      }): Promise<{ data: unknown[] }>;
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id?: string;
        body?: string;
        event?: string;
        comments?: GitHubDraftReviewComment[];
      }): Promise<{ data: { id: number } }>;
    };
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{ data: unknown }>;
      compareCommitsWithBasehead?(params: {
        owner: string;
        repo: string;
        basehead: string;
        page?: number;
        per_page?: number;
      }): Promise<{ data: { status: string; files?: unknown[] } }>;
    };
    issues?: {
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body?: string;
      }): Promise<{ data: { id: number; number: number; html_url?: string } }>;
    };
  };
}

/**
 * Adapts an Octokit instance (e.g. from App.getInstallationOctokit) to MergePilot's GitHubClient.
 */
export function wrapOctokit(octokit: OctokitLike): GitHubClient {
  return {
    async listPullRequestFilesPage(params: ListFilesPageParams): Promise<GitHubPullRequestFile[]> {
      const response = await octokit.rest.pulls.listFiles({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pull_number,
        page: params.page,
        per_page: params.per_page,
      });
      return response.data as GitHubPullRequestFile[];
    },

    async getPullRequest(params: GetPullRequestParams): Promise<GitHubPullRequest> {
      const response = await octokit.rest.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pull_number,
      });
      return response.data as GitHubPullRequest;
    },

    async listReviewsPage(params: ListReviewsPageParams): Promise<GitHubReview[]> {
      const response = await octokit.rest.pulls.listReviews({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pull_number,
        ...(params.page !== undefined ? { page: params.page } : {}),
        ...(params.per_page !== undefined ? { per_page: params.per_page } : {}),
      });
      return response.data as GitHubReview[];
    },

    async createReview(params: CreateReviewParams): Promise<GitHubCreatedReview> {
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
        throw error;
      }
    },

    async compareCommits(params: CompareCommitsParams): Promise<CompareCommitsResult | null> {
      if (!octokit.rest.repos.compareCommitsWithBasehead) {
        return null;
      }
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
        throw error;
      }
    },

    async createIssue(params: { owner: string; repo: string; title: string; body?: string }) {
      if (!octokit.rest.issues) {
        throw new Error('issues.create is not supported by this Octokit instance');
      }
      const response = await octokit.rest.issues.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        ...(params.body ? { body: params.body } : {}),
      });
      return {
        id: response.data.id,
        number: response.data.number,
        ...(response.data.html_url ? { html_url: response.data.html_url } : {}),
      };
    },
  };
}
