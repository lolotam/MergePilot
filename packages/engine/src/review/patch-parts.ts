/**
 * Splitting a patch that is bigger than one model call into parts (ADR-0045): whole hunks first,
 * and a hunk that is itself over the cap cut at line boundaries into sub-hunks whose headers are
 * recomputed, so every part is a valid unified patch with true line numbers. A single line too
 * big for the cap is cut too, and the review says how many lines were cut.
 */
import { estimateTokens } from './budget.js';

/** `@@ -1,3 +1,4 @@` and the text after it (git's section heading). */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The marker that says a line was cut to fit the cap. */
export const LINE_CUT_MARKER = ' [line cut to fit review.batchTokens]';

/** One hunk of a patch: its header, its heading and its body lines. */
interface Hunk {
  /** The header line as it was. */
  header: string;
  /** The text after the closing `@@`; only the first sub-hunk of a split hunk keeps it. */
  heading: string;
  /** The old-side line the hunk starts at, and how many old lines it covers. */
  oldStart: number;
  oldLines: number;
  /** The new-side line the hunk starts at, and how many new lines it covers. */
  newStart: number;
  newLines: number;
  /** The body lines: ' ', '-', '+' and the '\' markers. */
  lines: string[];
}

/** The parts of a patch, and the lines that had to be cut to fit the cap. */
export interface PatchParts {
  /**
   * Each part is a valid unified patch on its own (hunks only, no file headers), and the body
   * lines of all of them together are the body lines of the original patch.
   */
  parts: string[];
  /** The lines too big for the cap that were cut; the review says how many. */
  cutLines: number;
}

/**
 * The parts of a patch: each is a valid unified patch on its own (hunks only, no file headers),
 * and the body lines of all of them together are the body lines of the original patch.
 *
 * A patch at or under the cap is returned whole; a bigger one is cut at hunk boundaries, and a
 * hunk over the cap at line boundaries. The headers of the cut hunks are recomputed, so the line
 * numbers of every part are the numbers the model must cite. A single line too big for the cap
 * is cut in place: it keeps its line number and gets a marker that says it was cut.
 */
export function splitPatchIntoParts(patch: string, capTokens: number): PatchParts {
  if (estimateTokens(patch) <= capTokens) return { parts: [patch], cutLines: 0 };
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return { parts: [patch], cutLines: 0 };

  // Whole hunks while they fit; a hunk over the cap is cut into sub-hunks first.
  const pieces: string[] = [];
  let cutLines = 0;
  for (const hunk of hunks) {
    const rendered = renderHunk(hunk);
    if (estimateTokens(rendered) <= capTokens) {
      pieces.push(rendered);
    } else {
      const split = splitHunk(hunk, capTokens);
      pieces.push(...split.pieces);
      cutLines += split.cutLines;
    }
  }

  const parts: string[] = [];
  let current: string[] = [];
  // The length of the pieces of the part being built, so they are not joined again for every one.
  let currentChars = 0;
  for (const piece of pieces) {
    // The length of the pieces joined with a line break, as `estimateTokens` counts it.
    const joined = currentChars + piece.length + current.length;
    if (current.length > 0 && estimateChars(joined) > capTokens) {
      parts.push(current.join('\n'));
      current = [];
      currentChars = 0;
    }
    current.push(piece);
    currentChars += piece.length;
  }
  if (current.length > 0) parts.push(current.join('\n'));
  return { parts, cutLines };
}

/**
 * The token estimate of a text of `chars` characters: the same rounding as `estimateTokens` in
 * budget.ts, which counts the characters of the text it is given.
 */
function estimateChars(chars: number): number {
  return Math.ceil(chars / 3.5);
}

/** The hunks of a patch; the lines before the first hunk are its file headers, which no part carries. */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split('\n')) {
    const match = HUNK_HEADER_RE.exec(line);
    if (match) {
      current = {
        header: line,
        heading: (match[5] ?? '').replace(/\r$/, ''),
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return hunks;
}

/** A hunk as a patch: its header line, then its body lines. */
function renderHunk(hunk: Hunk): string {
  return [hunk.header, ...hunk.lines].join('\n');
}

/**
 * A hunk over the cap, cut at line boundaries: every sub-hunk gets a recomputed header, and the
 * text after the closing `@@` stays on the first sub-hunk only. The length of the body is tracked
 * as it grows, so a hunk of thousands of lines is cut in linear time.
 */
function splitHunk(hunk: Hunk, capTokens: number): { pieces: string[]; cutLines: number } {
  // The line number each side reaches next. A side the hunk does not touch starts after the
  // line its header names, as git counts an insertion point.
  let oldLine = hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 1;
  let newLine = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1;
  const pieces: string[] = [];
  let lines: string[] = [];
  let oldStart = oldLine;
  let newStart = newLine;
  let oldCount = 0;
  let newCount = 0;
  let heading = hunk.heading;
  // The length of the body lines of the sub-hunk being built.
  let bodyChars = 0;
  let cutLines = 0;

  const flush = (): void => {
    if (lines.length === 0) return;
    pieces.push(renderSubHunk(oldStart, oldCount, newStart, newCount, heading, lines));
    lines = [];
    oldCount = 0;
    newCount = 0;
    bodyChars = 0;
    heading = '';
  };

  for (const unit of groupUnits(hunk.lines)) {
    const line = unit[0] ?? '';
    // A ' ' line is on both sides, '-' on the old one, '+' on the new one.
    const unitOld = line.startsWith(' ') || line.startsWith('-') ? 1 : 0;
    const unitNew = line.startsWith(' ') || line.startsWith('+') ? 1 : 0;
    const unitChars = charsOf(unit);
    if (isOverLong(unit, capTokens)) {
      // A single line too big for the cap: cut its text and give it a sub-hunk of its own.
      flush();
      const cut = cutUnit(unit, capTokens);
      cutLines += 1;
      lines = cut;
      oldCount = unitOld;
      newCount = unitNew;
      bodyChars = charsOf(cut);
      oldStart = oldLine;
      newStart = newLine;
      flush();
      oldLine += unitOld;
      newLine += unitNew;
      oldStart = oldLine;
      newStart = newLine;
      continue;
    }
    // The size of the sub-hunk the unit would make.
    const candidate =
      headerChars(oldStart, oldCount + unitOld, newStart, newCount + unitNew, heading) +
      lines.length +
      unit.length +
      bodyChars +
      unitChars;
    if (lines.length > 0 && estimateChars(candidate) > capTokens) {
      flush();
      oldStart = oldLine;
      newStart = newLine;
    }
    lines.push(...unit);
    oldCount += unitOld;
    newCount += unitNew;
    bodyChars += unitChars;
    oldLine += unitOld;
    newLine += unitNew;
  }
  flush();
  return { pieces, cutLines };
}

/**
 * Whether a unit is a single line too big for the cap, and cutting it would bring it back within
 * it: a line that fits whole is never cut, and a line that would still not fit after the cut is
 * left as it is (the cap is then unreachable for that line).
 */
function isOverLong(unit: string[], capTokens: number): boolean {
  if (estimateChars(charsOf(unit)) <= capTokens) return false;
  const cutChars = 1 + Math.floor(capTokens * 3) + LINE_CUT_MARKER.length;
  return estimateChars(cutChars) <= capTokens;
}

/**
 * A sub-hunk with recomputed numbers: a side the sub-hunk does not touch starts at the line
 * before it, as git counts an insertion point.
 */
function renderSubHunk(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  heading: string,
  lines: string[],
): string {
  return [subHunkHeader(oldStart, oldCount, newStart, newCount, heading), ...lines].join('\n');
}

/** The header of a sub-hunk: its recomputed numbers and the heading of the hunk it came from. */
function subHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  heading: string,
): string {
  const old = oldCount > 0 ? oldStart : Math.max(0, oldStart - 1);
  const current = newCount > 0 ? newStart : Math.max(0, newStart - 1);
  return `@@ -${old},${oldCount} +${current},${newCount} @@${heading}`;
}

/** The length of the header of a sub-hunk. */
function headerChars(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  heading: string,
): number {
  return subHunkHeader(oldStart, oldCount, newStart, newCount, heading).length;
}

/** The length of the body lines, without the line breaks between them. */
function charsOf(lines: string[]): number {
  let chars = 0;
  for (const line of lines) chars += line.length;
  return chars;
}

/**
 * A line too big for the cap: its prefix and the beginning of its text, with a marker that says
 * the line was cut. The line keeps its place, so the line numbers of the file do not move.
 */
function cutUnit(unit: string[], capTokens: number): string[] {
  const line = unit[0] ?? '';
  const prefix = line.slice(0, 1);
  const text = line.slice(1);
  const maxChars = Math.max(0, Math.floor(capTokens * 3));
  return [`${prefix}${text.slice(0, maxChars)}${LINE_CUT_MARKER}`, ...unit.slice(1)];
}

/** The body lines as units: a '\ No newline at end of file' marker stays with the line above it. */
function groupUnits(lines: string[]): string[][] {
  const units: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('\\') && units.length > 0) {
      units[units.length - 1]!.push(line);
    } else {
      units.push([line]);
    }
  }
  return units;
}
