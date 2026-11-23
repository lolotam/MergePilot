function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function align(previous: unknown, next: unknown): unknown {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return previous.map((value: unknown, index) => align(value, next[index]));
  }
  if (isObject(previous) && isObject(next)) {
    const shared = Object.keys(next).filter((key) => Object.hasOwn(previous, key));
    const remaining = Object.keys(previous).filter((key) => !Object.hasOwn(next, key));
    return Object.fromEntries([
      ...shared.map((key) => [key, align(previous[key], next[key])] as const),
      ...remaining.map((key) => [key, previous[key]] as const),
    ]);
  }
  return previous;
}

/** Re-serialize the previous snapshot in the next one's key order, or return null for a raw diff. */
export function alignJsonKeyOrder(previous: string, next: string): string | null {
  try {
    const oldSnapshot: unknown = JSON.parse(previous);
    const newSnapshot: unknown = JSON.parse(next);
    if (!isObject(oldSnapshot) || !isObject(newSnapshot)) return null;
    const indent = /\n([ \t]+)\S/.exec(next)?.[1] ?? '  ';
    const newline = next.endsWith('\n') ? '\n' : '';
    if (JSON.stringify(newSnapshot, null, indent) + newline !== next) return null;
    return JSON.stringify(align(oldSnapshot, newSnapshot), null, indent) + newline;
  } catch {
    return null;
  }
}
