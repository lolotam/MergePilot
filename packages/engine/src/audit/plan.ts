import { matchesGlob } from '../diff/glob.js';
import { isSensitivePath as defaultIsSensitivePath } from '../security/sensitive-path.js';
import type { PlanAuditInput, PlanAuditResult, SkippedFile } from './types.js';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.tif',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.pdf',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wav',
  '.ogg',
  '.webm',
  '.mkv',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.iso',
  '.dmg',
  '.class',
  '.pyc',
]);

function isBinaryPath(path: string): boolean {
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = path.slice(dotIndex).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const DEFAULT_INCLUDE = ['**/*'];
const DEFAULT_EXCLUDE = ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'];
const DEFAULT_MAX_FILES = 200;

/**
 * The audit sends whole files in each chunk, so its chunk size stays where it was before the
 * review's `budget.maxInputTokens` default rose to 1,000,000 (ADR-0013 amendment): 70% of 200,000
 * tokens per call. A lower `budget.maxInputTokens` still shrinks the chunks.
 */
export const AUDIT_MAX_INPUT_TOKENS = 200_000;

export function planAudit(input: PlanAuditInput): PlanAuditResult {
  const {
    files,
    include = DEFAULT_INCLUDE,
    exclude = DEFAULT_EXCLUDE,
    maxFiles = DEFAULT_MAX_FILES,
    maxInputTokens,
    isSensitivePath = defaultIsSensitivePath,
  } = input;

  const sortedFiles = [...files].sort((a, b) => compareText(a.path, b.path));

  const eligibleFiles: Array<{ path: string; size: number }> = [];
  const skipped: SkippedFile[] = [];

  for (const file of sortedFiles) {
    if (isSensitivePath(file.path)) {
      skipped.push({ path: file.path, reason: 'sensitive' });
      continue;
    }

    if (isBinaryPath(file.path)) {
      skipped.push({ path: file.path, reason: 'binary' });
      continue;
    }

    if (exclude.some((pattern) => matchesGlob(file.path, pattern))) {
      skipped.push({ path: file.path, reason: 'excluded' });
      continue;
    }

    if (!include.some((pattern) => matchesGlob(file.path, pattern))) {
      skipped.push({ path: file.path, reason: 'excluded' });
      continue;
    }

    eligibleFiles.push(file);
  }

  const cappedFiles: Array<{ path: string; size: number }> = [];
  for (let i = 0; i < eligibleFiles.length; i++) {
    const file = eligibleFiles[i]!;
    if (i < maxFiles) {
      cappedFiles.push(file);
    } else {
      skipped.push({ path: file.path, reason: 'max-files' });
    }
  }

  // Re-sort skipped to maintain deterministic path asc order
  skipped.sort((a, b) => compareText(a.path, b.path));

  // Chunking
  const maxChunkTokens = Math.floor(Math.min(maxInputTokens, AUDIT_MAX_INPUT_TOKENS) * 0.7);
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentChunkTokens = 0;

  for (const file of cappedFiles) {
    const estTokens = Math.ceil(file.size / 3.5);

    if (currentChunk.length > 0 && currentChunkTokens + estTokens > maxChunkTokens) {
      chunks.push(currentChunk);
      currentChunk = [file.path];
      currentChunkTokens = estTokens;
    } else {
      currentChunk.push(file.path);
      currentChunkTokens += estTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return {
    chunks,
    skipped,
  };
}
