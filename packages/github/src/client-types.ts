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
  labels?: Array<{ name: string }>;
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
  totalCommits?: number;
  /** The merge base of the two commits: where the common history ends (ADR-0045). */
  mergeBaseSha?: string;
}

export interface GitHubReviewComment {
  id: number;
  path: string;
  line: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  side?: string;
  body: string;
  user?: { login: string } | null;
}

export interface ListReviewCommentsParams {
  owner: string;
  repo: string;
  pull_number: number;
  page?: number;
  per_page?: number;
}

export interface ListReviewThreadsParams {
  owner: string;
  repo: string;
  pull_number: number;
}

/** A review thread (GraphQL): whether it was resolved, and the REST id of its first comment. */
export interface GitHubReviewThread {
  isResolved: boolean;
  firstCommentId: number | null;
}

export interface GitHubIssueComment {
  id: number;
  body?: string | null;
  user?: { login: string } | null;
  author_association?: string;
}

export interface ListIssueCommentsParams {
  owner: string;
  repo: string;
  issue_number: number;
  page?: number;
  per_page?: number;
}

export interface CreateIssueCommentParams {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

export interface AddLabelsParams {
  owner: string;
  repo: string;
  issue_number: number;
  labels: string[];
}

export interface RemoveLabelParams {
  owner: string;
  repo: string;
  issue_number: number;
  name: string;
}

export interface GetCollaboratorPermissionParams {
  owner: string;
  repo: string;
  username: string;
}

export interface GitHubCollaboratorPermission {
  permission: string;
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
  /**
   * The files directly in a directory at `ref`, plus its subdirectories with a trailing '/'; null
   * when it does not exist.
   */
  listDirectoryFiles?(params: GetFileContentParams): Promise<string[] | null>;
  /**
   * Every blob path of the git tree at `ref`, recursive, and whether the listing is partial: the
   * API truncates a big tree, and the paths it left out are not in the list. Null when it is not
   * available (the client has no such method, or the tree does not exist).
   */
  listTreePaths?(params: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<{ paths: string[]; truncated: boolean } | null>;
  compareCommits(params: CompareCommitsParams): Promise<CompareCommitsResult | null>;
  createIssue?(params: CreateIssueParams): Promise<GitHubCreatedIssue>;
  listReviewCommentsPage?(params: ListReviewCommentsParams): Promise<GitHubReviewComment[]>;
  /** Every review thread of the PR, all pages (GraphQL); open findings need it (ADR-0030). */
  listReviewThreads?(params: ListReviewThreadsParams): Promise<GitHubReviewThread[]>;
  listIssueCommentsPage?(params: ListIssueCommentsParams): Promise<GitHubIssueComment[]>;
  createIssueComment?(params: CreateIssueCommentParams): Promise<{ id: number }>;
  addLabels?(params: AddLabelsParams): Promise<void>;
  removeLabel?(params: RemoveLabelParams): Promise<void>;
  getCollaboratorPermission?(params: GetCollaboratorPermissionParams): Promise<GitHubCollaboratorPermission>;
}
