import { matchesGlob } from './glob.js';

export type FileClassification =
  | 'review'
  | 'skip-removed'
  | 'skip-binary'
  | 'skip-excluded'
  | 'skip-generated'
  | 'skip-sensitive'
  | 'incomplete-truncated';

export interface FileToClassify {
  path: string;
  status: string;
  patch?: string | undefined;
  changes: number;
}

export interface ClassifyFileOptions {
  exclude: string[];
  isSensitivePath: (p: string) => boolean;
}

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
]);

function matchesGlobPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  if (matchesGlob(normalizedPath, normalizedPattern)) {
    return true;
  }

  // If pattern has no slash, it can match basename or nested paths
  if (!normalizedPattern.includes('/')) {
    const base = normalizedPath.split('/').pop() ?? '';
    if (matchesGlob(base, normalizedPattern)) {
      return true;
    }
    if (matchesGlob(normalizedPath, `**/${normalizedPattern}`)) {
      return true;
    }
  }

  // If pattern ends with '/', match whole directory tree
  if (normalizedPattern.endsWith('/')) {
    if (matchesGlob(normalizedPath, `${normalizedPattern}**`)) {
      return true;
    }
    if (!normalizedPattern.startsWith('/') && matchesGlob(normalizedPath, `**/${normalizedPattern}**`)) {
      return true;
    }
  }

  return false;
}

function isGeneratedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const base = segments[segments.length - 1] ?? '';

  if (LOCKFILES.has(base)) {
    return true;
  }

  // dist/ or build/ at any depth
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.includes('dist') || dirSegments.includes('build')) {
    return true;
  }

  if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.map')) {
    return true;
  }

  if (matchesGlobPattern(base, '*.generated.*')) {
    return true;
  }

  return false;
}

/**
 * Classifies a file from a pull request diff to determine whether it should be reviewed
 * or skipped, according to PRD v0.2 §7 step 2.
 *
 * Evaluation order:
 * 1. removed
 * 2. sensitive
 * 3. excluded
 * 4. generated
 * 5. binary (no patch and changes === 0)
 * 6. truncated (no patch and changes > 0)
 * 7. review
 */
export function classifyFile(
  file: FileToClassify,
  opts: ClassifyFileOptions,
): FileClassification {
  if (file.status === 'removed') {
    return 'skip-removed';
  }

  if (opts.isSensitivePath(file.path)) {
    return 'skip-sensitive';
  }

  if (opts.exclude.some((pattern) => matchesGlobPattern(file.path, pattern))) {
    return 'skip-excluded';
  }

  if (isGeneratedPath(file.path)) {
    return 'skip-generated';
  }

  if (!file.patch && file.changes === 0) {
    return 'skip-binary';
  }

  if (!file.patch && file.changes > 0) {
    return 'incomplete-truncated';
  }

  return 'review';
}
