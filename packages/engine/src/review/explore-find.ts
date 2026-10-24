/**
 * The matches of one search (ADR-0046): the lines of the files a review holds and of the files it
 * read that hold the searched text. A file at the head has its own line numbers. A patch has not:
 * its matches take the head's line numbers from the hunk headers, so a context or an added line
 * carries the number of the head, a removed line carries none and says so, and the lines outside a
 * hunk (the diff's own header) are never matched.
 */

/** How much of a matched line is shown. */
const MAX_MATCH_CHARS = 200;

/** A match of a search: the line of the head and the text that matched. */
export interface FindMatch {
  /** The head's line number; undefined for a removed line of a patch. */
  line: number | undefined;
  /** The text of the line, trimmed and cut. */
  text: string;
}

/** The hunk header of a unified patch: the head's line number its body starts at. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The matches of a file at the head: its own line numbers, one-based.
 */
export function matchesInFile(text: string, needle: string, limit: number): FindMatch[] {
  const matches: FindMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!line.includes(needle)) continue;
    matches.push({ line: index + 1, text: line.trim().slice(0, MAX_MATCH_CHARS) });
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * The matches of a unified patch: the head's line numbers come from the hunk headers, so an added
 * or a context line carries the number of the head and a removed line carries none.
 */
export function matchesInPatch(text: string, needle: string, limit: number): FindMatch[] {
  const matches: FindMatch[] = [];
  let headLine: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      headLine = Number(header[1]);
      continue;
    }
    // The lines before the first hunk are the diff's own header: they are never matched.
    if (headLine === undefined) continue;
    // The marker of a file that ends without a newline is not a line of the file.
    if (raw.startsWith('\\')) continue;
    const removed = raw.startsWith('-');
    const body = removed || raw.startsWith('+') || raw.startsWith(' ') ? raw.slice(1) : raw;
    if (body.includes(needle)) {
      matches.push({
        line: removed ? undefined : headLine,
        text: body.trim().slice(0, MAX_MATCH_CHARS),
      });
      if (matches.length >= limit) break;
    }
    // A removed line is not part of the head's file: it does not move its line number.
    if (!removed) headLine += 1;
  }
  return matches;
}

/** The place of a match, as a search shows it: `path:line`, or `path (removed line)`. */
export function matchPlace(path: string, match: FindMatch): string {
  return match.line === undefined ? `${path} (removed line)` : `${path}:${match.line}`;
}
