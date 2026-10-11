import type { GitHubClient, GitHubPullRequestFile } from './client.js';

export interface PullRequestFile {
  path: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
  changes: number;
  previousPath?: string;
}

export interface PullRequestFilesResult {
  files: PullRequestFile[];
  truncatedList: boolean;
}

export interface ListPullRequestFilesOptions {
  owner: string;
  repo: string;
  pull_number: number;
}

const GITHUB_FILE_CAP = 3000;
const PAGE_SIZE = 100;

function mapGitHubFile(file: GitHubPullRequestFile): PullRequestFile {
  const mapped: PullRequestFile = {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  };
  if (file.patch !== undefined) {
    mapped.patch = file.patch;
  }
  if (file.previous_filename !== undefined) {
    mapped.previousPath = file.previous_filename;
  }
  return mapped;
}

/**
 * Lists all changed files for a pull request by fetching paginated results (100 per page).
 * Stops when results are exhausted or when GitHub's 3,000-file cap is reached.
 */
export async function listPullRequestFiles(
  client: GitHubClient,
  { owner, repo, pull_number }: ListPullRequestFilesOptions,
): Promise<PullRequestFilesResult> {
  const files: PullRequestFile[] = [];
  let page = 1;
  let truncatedList = false;

  while (true) {
    const rawFiles = await client.listPullRequestFilesPage({
      owner,
      repo,
      pull_number,
      page,
      per_page: PAGE_SIZE,
    });

    if (rawFiles.length === 0) {
      break;
    }

    for (const rawFile of rawFiles) {
      files.push(mapGitHubFile(rawFile));
      if (files.length === GITHUB_FILE_CAP) {
        truncatedList = true;
        break;
      }
    }

    if (truncatedList) {
      break;
    }

    if (rawFiles.length < PAGE_SIZE) {
      break;
    }

    page++;
  }

  return {
    files,
    truncatedList,
  };
}
