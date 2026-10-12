/**
 * Models quoting code (regexes, Windows paths) often write invalid JSON escapes such as `\d` or
 * `\.` inside strings, and `JSON.parse` rejects the whole answer for one of them. A backslash
 * that does not start a valid JSON escape is taken literally (doubled) before parsing again.
 * Valid escapes, including `\\`, are left untouched.
 */
const ESCAPE = /\\(u[0-9a-fA-F]{4}|[\s\S])/g;
const VALID_SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

export function repairInvalidEscapes(json: string): string {
  return json.replace(ESCAPE, (match, escaped: string) =>
    escaped.length === 5 || VALID_SIMPLE_ESCAPES.has(escaped) ? match : `\\\\${escaped}`,
  );
}

/** `JSON.parse`, retried once with invalid escapes repaired; throws the original error if both fail. */
export function parseJsonLenient(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    const repaired = repairInvalidEscapes(json);
    if (repaired === json) throw error;
    try {
      return JSON.parse(repaired);
    } catch {
      throw error;
    }
  }
}
