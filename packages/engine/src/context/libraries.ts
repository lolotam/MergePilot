/**
 * Pure engine library analysis:
 * - Parses manifest dependencies into concrete versions.
 * - Detects touched libraries in JS/TS patches for prompt contextualization.
 */

const JS_TS_EXTENSION_RE = /\.[mc]?[jt]sx?$/i;

/**
 * Strips range operators from a dependency version specifier to a concrete-looking version.
 * Skips workspace, file, link, git, URL specifiers, and generic wildcards/tags.
 */
function cleanVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.startsWith('workspace:') ||
    trimmed.startsWith('file:') ||
    trimmed.startsWith('link:') ||
    trimmed.startsWith('git:') ||
    trimmed.startsWith('git+') ||
    trimmed.startsWith('github:') ||
    trimmed.startsWith('http:') ||
    trimmed.startsWith('https:') ||
    trimmed.includes('/') ||
    trimmed.includes(':')
  ) {
    return null;
  }
  if (trimmed === '*' || trimmed === 'latest' || trimmed === 'next') {
    return null;
  }
  // Strip leading range operators: ^, ~, >=, <=, >, <, =, v, and spaces
  const stripped = trimmed.replace(/^[~^=v><\s]+/, '').trim();
  const firstToken = stripped.split(/\s+/)[0] ?? '';
  if (/^\d+(\.\d+)*/.test(firstToken)) {
    return firstToken;
  }
  return null;
}

/**
 * Normalizes an imported/required module specifier to its package name.
 * Handles scoped packages (@a/b/c -> @a/b) and subpaths (x/y -> x).
 * Returns null for relative or node: built-in imports.
 */
function normalizePackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (
    trimmed.startsWith('.') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('node:')
  ) {
    return null;
  }

  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  const parts = trimmed.split('/');
  return parts[0] || null;
}

/**
 * Parses package.json manifest text and returns a Map of library names to concrete versions.
 * Inspects dependencies, devDependencies, and peerDependencies in priority order.
 */
export function parseManifestVersions(packageJsonText: string): Map<string, string> {
  const result = new Map<string, string>();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(packageJsonText);
  } catch {
    return result;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return result;
  }

  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  for (const section of sections) {
    const deps = data[section];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string') {
          continue;
        }
        if (result.has(name)) {
          continue;
        }
        const version = cleanVersion(spec);
        if (version !== null) {
          result.set(name, version);
        }
      }
    }
  }

  return result;
}

export interface PatchFile {
  path: string;
  patch?: string | undefined;
}

// Regex matching import forms:
// 1. dynamic import: import('x')
// 2. CommonJS require: require('x')
// 3. side-effect import: import 'x'
// 4. static import: import ... from 'x'
// 5. multiline closing line: } from 'x' or from 'x'
const IMPORT_RE =
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\bimport\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]|(?:\bfrom|\}\s*from)\s*['"]([^'"]+)['"]/g;

/**
 * Identifies libraries imported or required in added lines of JS/TS files.
 * Returns unique library names present in versions, ordered by first appearance.
 */
export function detectTouchedLibraries(
  files: PatchFile[],
  versions: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const file of files) {
    if (!JS_TS_EXTENSION_RE.test(file.path) || !file.patch) {
      continue;
    }

    const lines = file.patch.split(/\r?\n/);
    let inHunk = false;
    const addedBlocks: string[] = [];
    let currentBlock: string[] = [];

    for (const line of lines) {
      if (line.startsWith('@@')) {
        inHunk = true;
        if (currentBlock.length > 0) {
          addedBlocks.push(currentBlock.join('\n'));
          currentBlock = [];
        }
        continue;
      }
      if (!inHunk) {
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentBlock.push(line.slice(1));
      } else {
        if (currentBlock.length > 0) {
          addedBlocks.push(currentBlock.join('\n'));
          currentBlock = [];
        }
      }
    }
    if (currentBlock.length > 0) {
      addedBlocks.push(currentBlock.join('\n'));
    }

    for (const block of addedBlocks) {
      IMPORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMPORT_RE.exec(block)) !== null) {
        const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
        if (!spec) {
          continue;
        }
        const pkgName = normalizePackageName(spec);
        if (pkgName && versions.has(pkgName) && !seen.has(pkgName)) {
          seen.add(pkgName);
          result.push(pkgName);
        }
      }
    }
  }

  return result;
}
