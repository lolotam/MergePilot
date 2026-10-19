const ROOT_CITED_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'yml', 'yaml', 'json', 'toml', 'sql']);

/** A slash path, or a root documentation/config name that still needs a root-listing check. */
export function isCitedPath(path: string): boolean {
  if (path.startsWith('this.') || path.startsWith('www.') || path.includes('://')) return false;
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  if (!/^[\p{L}\p{N}_@.-]+\.[a-zA-Z]\w*$/u.test(name)) return false;
  if (segments.length === 0) return ROOT_CITED_EXTENSIONS.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
  return segments.every((segment) => segment !== '.' && segment !== '..' && (
    /^[\p{L}\p{N}_@.-]+$/u.test(segment) ||
    /^\([\p{L}\p{N}_@.-]+\)$/u.test(segment) ||
    /^\[(?:\.\.\.)?[\p{L}\p{N}_-]+\]$/u.test(segment) ||
    /^\[\[\.\.\.[\p{L}\p{N}_-]+\]\]$/u.test(segment)
  ));
}

