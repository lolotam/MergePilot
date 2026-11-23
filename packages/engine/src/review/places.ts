/**
 * The "Also at:" line of a body and the lines that carry on its list: the rest of that line, then
 * every following line up to the first blank line, so a list the model wrapped or bulleted is read
 * whole.
 */
export const ALSO_AT_BLOCK_RE = /^[ \t]*Also at:([^\n]*(?:\n(?![ \t]*$)[^\n]*)*)/m;

/** One place a list names, with where it sits in the list text. */
interface AlsoAtMatch {
  path: string;
  line: number;
  start: number;
  end: number;
}

/**
 * The `path:line` places a finding lists on its "Also at:" line (ADR-0039 pattern sweep). Only known
 * paths count, matched whole, so a path holding spaces or commas is read as one place. A known path
 * that sits inside another match is part of that place, not a place of its own.
 */
export function alsoAtPlaces(body: string, paths: readonly string[]): Array<{ path: string; line: number }> {
  return placesInText(ALSO_AT_BLOCK_RE.exec(body)?.[1] ?? '', paths);
}

/** Known path:line references in free text, in order of appearance. */
export function placesInText(text: string, paths: readonly string[]): Array<{ path: string; line: number }> {
  if (!text) return [];
  const matches: AlsoAtMatch[] = [];
  for (const path of paths) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const place of text.matchAll(new RegExp(`(?<![\\w./-])${escaped}:(\\d+)`, 'g'))) {
      const digits = place[1] ?? '';
      // The match is the path, a colon, then the line number.
      const end = place.index + path.length + 1 + digits.length;
      matches.push({ path, line: Number(digits), start: place.index, end });
    }
  }
  // Left to right, and at the same spot the longer path wins. A match that overlaps a kept one is
  // part of it, not a place of its own.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: AlsoAtMatch[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    if (match.start < lastEnd) continue;
    kept.push(match);
    lastEnd = match.end;
  }
  return kept.map((match) => ({ path: match.path, line: match.line }));
}
