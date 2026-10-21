import type { GitHubClient } from './client.js';

export interface ReadFilesAtRefParams {
  owner: string;
  repo: string;
  ref: string;
  paths: string[];
}

export interface FileContent {
  path: string;
  content: string;
}

/** Whether a GitHub API error is a 404 (the path or ref does not exist). */
export function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 404;
}

/**
 * The files of a directory listing, plus its subdirectories with a trailing '/'; null when `data`
 * is not a listing.
 */
export function directoryFilesOf(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null;
  return data.flatMap((item: unknown) => {
    const entry = item as { type?: unknown; path?: unknown };
    if (typeof entry.path !== 'string') return [];
    if (entry.type === 'file') return [entry.path];
    if (entry.type === 'dir') return [`${entry.path}/`];
    return [];
  });
}

const MAX_FILE_BYTES = 100 * 1024;
const TRUNCATION_NOTE = '\n\n[Truncated: file exceeds 100 KB]';

/**
 * Truncates file content if it exceeds 100 KB and appends a truncation notice.
 */
export function capFileContent(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= MAX_FILE_BYTES) {
    return content;
  }
  return buf.subarray(0, MAX_FILE_BYTES).toString('utf8') + TRUNCATION_NOTE;
}

/**
 * Reads multiple files at a specific git ref from GitHub.
 * Missing files (404 or directory) are skipped.
 * Files larger than 100 KB are truncated with a note.
 */
export async function readFilesAtRef(
  client: GitHubClient,
  { owner, repo, ref, paths }: ReadFilesAtRefParams,
): Promise<FileContent[]> {
  const results: FileContent[] = [];

  for (const path of paths) {
    const rawContent = await client.getFileContent({ owner, repo, path, ref });
    if (rawContent !== null) {
      results.push({
        path,
        content: capFileContent(rawContent),
      });
    }
  }

  return results;
}
