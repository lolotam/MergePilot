/**
 * Lightweight glob matcher supporting '*', '**', and '?' without external dependencies.
 */

function globToRegex(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/');
  let re = '^';
  let i = 0;

  while (i < norm.length) {
    // Check for '/**/' (zero or more directory segments between slashes)
    if (norm.slice(i, i + 4) === '/**/') {
      re += '(?:/|/.+/)';
      i += 4;
      continue;
    }

    // Check for trailing '/**' (matches directory and everything under it)
    if (norm.slice(i) === '/**') {
      re += '(?:/.*)?';
      i += 3;
      continue;
    }

    // Check for leading '**/' (matches root or any parent directory)
    if (i === 0 && norm.slice(0, 3) === '**/') {
      re += '(?:.+/)?';
      i += 3;
      continue;
    }

    // Check for standalone '**'
    if (norm.slice(i, i + 2) === '**') {
      re += '.*';
      i += 2;
      continue;
    }

    // Check for single '*' (matches characters within a single directory segment)
    if (norm[i] === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }

    // Check for '?' (matches single character within a directory segment)
    if (norm[i] === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }

    const char = norm[i] ?? '';
    if (
      char === '.' ||
      char === '+' ||
      char === '^' ||
      char === '$' ||
      char === '(' ||
      char === ')' ||
      char === '[' ||
      char === ']' ||
      char === '{' ||
      char === '}' ||
      char === '|' ||
      char === '\\'
    ) {
      re += `\\${char}`;
    } else {
      re += char;
    }
    i += 1;
  }

  re += '$';
  return new RegExp(re);
}

/**
 * Checks whether a file path matches a glob pattern.
 * Supports:
 * - '*' matches within a directory segment
 * - '**' matches across directory segments
 * - '?' matches a single character within a directory segment
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');

  const regex = globToRegex(normPattern);
  if (regex.test(normPath)) {
    return true;
  }

  // If pattern does not contain a slash (e.g. '*.md'), also test basename
  if (!normPattern.includes('/')) {
    const base = normPath.split('/').pop() ?? '';
    if (regex.test(base)) {
      return true;
    }
  }

  // If pattern ends with '/', match directory prefix at any depth
  if (normPattern.endsWith('/')) {
    const dirPrefix = normPattern.slice(0, -1);
    if (globToRegex(`${dirPrefix}/**`).test(normPath)) {
      return true;
    }
    if (globToRegex(`**/${dirPrefix}/**`).test(normPath)) {
      return true;
    }
  }

  return false;
}
