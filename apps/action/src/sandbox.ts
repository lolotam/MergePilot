import {
  copyFile as fsCopyFile,
  lstat as fsLstat,
  mkdir as fsMkdir,
  mkdtemp as fsMkdtemp,
  readdir as fsReaddir,
  rm as fsRm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isSensitivePath } from '@mergepilot/engine';

export interface CreateSanitizedWorkspaceOptions {
  sourceDir: string;
  listFiles?: ((sourceDir: string) => Promise<string[]> | string[]) | undefined;
  copyFile?: ((src: string, dest: string) => Promise<void> | void) | undefined;
  mkdtemp?: ((prefix: string) => Promise<string> | string) | undefined;
  rm?: ((dir: string) => Promise<void> | void) | undefined;
}

export interface SanitizedWorkspace {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Checks whether a repository-relative path should be excluded from the sanitized workspace.
 * Excludes at any depth:
 * - CLAUDE.md
 * - CLAUDE.local.md
 * - .claude/
 * - .mcp.json
 * - AGENTS.md
 * - .cursor/
 * - .github/copilot-instructions.md
 * - and every path isSensitivePath flags.
 */
export function isExcludedFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  const segments = normalized.split('/');
  const filename = segments[segments.length - 1] ?? '';
  const lowerFilename = filename.toLowerCase();

  // Exclude at any depth: CLAUDE.md, CLAUDE.local.md, AGENTS.md, .mcp.json
  if (
    lowerFilename === 'claude.md' ||
    lowerFilename === 'claude.local.md' ||
    lowerFilename === 'agents.md' ||
    lowerFilename === '.mcp.json'
  ) {
    return true;
  }

  // Exclude at any depth: .claude, .cursor, .git, node_modules directories or files
  for (const seg of segments) {
    const lowerSeg = seg.toLowerCase();
    if (
      lowerSeg === '.claude' ||
      lowerSeg === '.cursor' ||
      lowerSeg === '.git' ||
      lowerSeg === 'node_modules'
    ) {
      return true;
    }
  }

  // Exclude .github/copilot-instructions.md at any depth
  if (lowerFilename === 'copilot-instructions.md') {
    const parentDir = segments[segments.length - 2]?.toLowerCase();
    if (parentDir === '.github') {
      return true;
    }
  }

  // Exclude anything flagged by isSensitivePath (e.g. .env, id_rsa, *.pem, *.key, etc.)
  if (isSensitivePath(normalized) || isSensitivePath(filename)) {
    return true;
  }

  return false;
}

/**
 * Recursively walks a directory, skipping symlinks, .git, and node_modules.
 */
async function walkDirectory(dir: string, baseDir: string): Promise<string[]> {
  const entries = await fsReaddir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Skip symlinks entirely (never follow symlinks out of sourceDir)
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      const lowerName = entry.name.toLowerCase();
      if (
        lowerName === '.git' ||
        lowerName === 'node_modules' ||
        lowerName === '.claude' ||
        lowerName === '.cursor'
      ) {
        continue;
      }
      const subFiles = await walkDirectory(join(dir, entry.name), baseDir);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath);
      files.push(relPath);
    }
  }

  return files;
}

/**
 * Copies the repository files into a fresh temp directory, excluding untrusted
 * agent instruction files and sensitive credentials so that only BASE branch rules
 * govern the review. Never follows symlinks.
 */
export async function createSanitizedWorkspace(
  options: CreateSanitizedWorkspaceOptions,
): Promise<SanitizedWorkspace> {
  const { sourceDir } = options;

  const mkdtempFn = options.mkdtemp ?? ((prefix: string) => fsMkdtemp(prefix));
  const defaultPrefix = join(tmpdir(), 'mergepilot-sandbox-');
  const targetDir = await mkdtempFn(defaultPrefix);

  const copyFileFn =
    options.copyFile ??
    (async (src: string, dest: string) => {
      await fsMkdir(dirname(dest), { recursive: true });
      await fsCopyFile(src, dest);
    });

  const rmFn =
    options.rm ??
    (async (dir: string) => {
      await fsRm(dir, { recursive: true, force: true });
    });

  const rawFiles = options.listFiles
    ? await options.listFiles(sourceDir)
    : await walkDirectory(sourceDir, sourceDir);

  for (const file of rawFiles) {
    const relPath = isAbsolute(file) ? relative(sourceDir, file) : file;
    // A path that leaves sourceDir would also leave the sandbox when joined below.
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      continue;
    }
    if (isExcludedFile(relPath)) {
      continue;
    }

    const srcPath = isAbsolute(file) ? file : join(sourceDir, relPath);

    // Skip symlinks entirely if detected on disk
    try {
      const stat = await fsLstat(srcPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
    } catch {
      // Injected / mocked tests may use non-existent file paths; continue to copyFile
    }

    const destPath = join(targetDir, relPath);
    await copyFileFn(srcPath, destPath);
  }

  return {
    dir: targetDir,
    cleanup: async () => {
      await rmFn(targetDir);
    },
  };
}
