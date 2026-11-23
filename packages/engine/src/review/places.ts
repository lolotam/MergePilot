/**
 * The "Also at:" line of a body and the lines that carry on its list: the rest of that line, then
 * every following line up to the first blank line, so a list the model wrapped or bulleted is read
 * whole.
 */
export const ALSO_AT_BLOCK_RE = /^[ \t]*Also at:([^\n]*(?:\n(?![ \t]*$)[^\n]*)*)/m;

const NON_LIST_LINE_RE = /^[ \t]*(?:```|~~~|#|>|\|)/;
const LIST_BULLET_RE = /^[ \t]*(?:[-*+][ \t]+)?/;
const SIMPLE_PATH_RE = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const DIR_SPACE_PATH_RE = /^[\w.@+-]+\/[^\n:`]+$/;

/** One place a list names, with where it sits in the list text. */
interface AlsoAtMatch {
  path: string;
  line: number;
  start: number;
  end: number;
}

/** Parses one complete `path:line` entry (optionally backticked) without matching prose sentences. */
function parseLocationEntry(raw: string, knownPaths: readonly string[]): { path: string; line: number } | null {
  let entry = raw.trim();
  if (!entry) return null;
  const backticked = entry.length >= 2 && entry.startsWith('`') && entry.endsWith('`');
  if (backticked) entry = entry.slice(1, -1).trim();
  const colon = entry.lastIndexOf(':');
  if (colon <= 0) return null;
  const digits = entry.slice(colon + 1);
  if (!/^\d+$/.test(digits)) return null;
  const path = entry.slice(0, colon);
  if (!path || /^https?:\/\//i.test(path)) return null;
  if (knownPaths.includes(path)) return { path, line: Number(digits) };
  if (backticked && !path.includes('`') && !path.includes(':')) return { path, line: Number(digits) };
  if (SIMPLE_PATH_RE.test(path)) return { path, line: Number(digits) };
  if (DIR_SPACE_PATH_RE.test(path) && !/[.!?]\s/.test(path)) return { path, line: Number(digits) };
  return null;
}

function isLocationListLine(line: string, knownPaths: readonly string[]): boolean {
  if (NON_LIST_LINE_RE.test(line)) return false;
  const stripped = line.replace(LIST_BULLET_RE, '').trim();
  if (!stripped) return false;
  // Whole-line match handles known paths that contain commas.
  if (parseLocationEntry(stripped.replace(/,$/, ''), knownPaths)) return true;
  const parts = stripped.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => parseLocationEntry(part, knownPaths) !== null);
}

/**
 * Character bounds of the `Also at:` location list within `text`, stopping before adjacent code
 * fences, Markdown blocks, or prose lines that do not parse strictly as location entries.
 */
export function alsoAtBlockRange(
  text: string,
  knownPaths: readonly string[] = [],
): { start: number; end: number; contentStart: number } | null {
  const block = ALSO_AT_BLOCK_RE.exec(text);
  if (!block) return null;
  const lines = block[0].split('\n');
  let rawEnd = lines[0]!.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isLocationListLine(line, knownPaths)) break;
    rawEnd += 1 + line.length;
  }
  const trimmedLength = block[0].slice(0, rawEnd).trimEnd().length;
  const colon = block[0].indexOf(':');
  return {
    start: block.index,
    end: block.index + trimmedLength,
    contentStart: block.index + (colon === -1 ? trimmedLength : colon + 1),
  };
}

function knownMatchesInText(text: string, paths: readonly string[]): AlsoAtMatch[] {
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
  return kept;
}

/**
 * The `path:line` places a finding lists on its "Also at:" line (ADR-0039 pattern sweep). Only known
 * paths count, matched whole, so a path holding spaces or commas is read as one place. A known path
 * that sits inside another match is part of that place, not a place of its own.
 */
export function alsoAtPlaces(body: string, paths: readonly string[]): Array<{ path: string; line: number }> {
  const range = alsoAtBlockRange(body, paths);
  if (!range) return [];
  return placesInText(body.slice(range.contentStart, range.end), paths);
}

/**
 * Extracts `path:line` entries from the bounded `Also at:` list in one pass: known paths match
 * whole first, and remaining comma/line entries outside matched spans are parsed as complete
 * location entries so paths with spaces, multiple dots, or no extension are preserved without
 * emitting truncated suffixes.
 */
export function alsoAtPlacesWithFallback(
  body: string,
  knownPaths: readonly string[],
): Array<{ path: string; line: number }> {
  const range = alsoAtBlockRange(body, knownPaths);
  if (!range) return [];
  const content = body.slice(range.contentStart, range.end);
  const knownMatches = knownMatchesInText(content, knownPaths);
  const all: AlsoAtMatch[] = [...knownMatches];
  let cursor = 0;
  for (const line of content.split('\n')) {
    const lineStart = cursor;
    cursor += line.length + 1;
    const bulletMatch = LIST_BULLET_RE.exec(line);
    const bodyOffset = bulletMatch ? bulletMatch[0].length : 0;
    const bodyText = line.slice(bodyOffset);
    let tokenOffset = 0;
    for (const part of bodyText.split(',')) {
      const partStart = lineStart + bodyOffset + tokenOffset;
      const partEnd = partStart + part.length;
      tokenOffset += part.length + 1;
      if (knownMatches.some((match) => match.start < partEnd && match.end > partStart)) continue;
      const parsed = parseLocationEntry(part, knownPaths);
      if (parsed) all.push({ ...parsed, start: partStart, end: partEnd });
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  return all.map(({ path, line }) => ({ path, line }));
}

/** Known path:line references in free text, in order of appearance. */
export function placesInText(text: string, paths: readonly string[]): Array<{ path: string; line: number }> {
  return knownMatchesInText(text, paths).map((match) => ({ path: match.path, line: match.line }));
}
