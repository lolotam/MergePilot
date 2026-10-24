/**
 * Splitting a patch that is bigger than one model call into parts (ADR-0045): whole hunks first,
 * and a hunk that is itself over the cap cut at line boundaries into sub-hunks whose headers are
 * recomputed, so every part is a valid unified patch with true line numbers.
 */
import { estimateTokens } from './budget.js';

/** `@@ -1,3 +1,4 @@` and the text after it (git's section heading). */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

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

/**
 * The parts of a patch: each is a valid unified patch on its own (hunks only, no file headers),
 * and the body lines of all of them together are the body lines of the original patch.
 *
 * A patch at or under the cap is returned whole; a bigger one is cut at hunk boundaries, and a
 * hunk over the cap at line boundaries. The headers of the cut hunks are recomputed, so the line
 * numbers of every part are the numbers the model must cite.
 */
export function splitPatchIntoParts(patch: string, capTokens: number): string[] {
  if (estimateTokens(patch) <= capTokens) return [patch];
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return [patch];

  // Whole hunks while they fit; a hunk over the cap is cut into sub-hunks first.
  const pieces: string[] = [];
  for (const hunk of hunks) {
    const rendered = renderHunk(hunk);
    if (estimateTokens(rendered) <= capTokens) pieces.push(rendered);
    else pieces.push(...splitHunk(hunk, capTokens));
  }

  const parts: string[] = [];
  let current: string[] = [];
  for (const piece of pieces) {
    if (current.length > 0 && estimateTokens([...current, piece].join('\n')) > capTokens) {
      parts.push(current.join('\n'));
      current = [];
    }
    current.push(piece);
  }
  if (current.length > 0) parts.push(current.join('\n'));
  return parts;
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
 * text after the closing `@@` stays on the first sub-hunk only.
 */
function splitHunk(hunk: Hunk, capTokens: number): string[] {
  // The line number each side reaches next. A side the hunk does not touch starts after the
  // line its header names, as git counts an insertion point.
  let oldLine = hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 1;
  let newLine = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1;
  const subHunks: string[] = [];
  let lines: string[] = [];
  let oldStart = oldLine;
  let newStart = newLine;
  let oldCount = 0;
  let newCount = 0;
  let heading = hunk.heading;

  const flush = (): void => {
    if (lines.length === 0) return;
    subHunks.push(renderSubHunk(oldStart, oldCount, newStart, newCount, heading, lines));
    lines = [];
    oldCount = 0;
    newCount = 0;
    heading = '';
  };

  for (const unit of groupUnits(hunk.lines)) {
    const line = unit[0] ?? '';
    // A ' ' line is on both sides, '-' on the old one, '+' on the new one.
    const unitOld = line.startsWith(' ') || line.startsWith('-') ? 1 : 0;
    const unitNew = line.startsWith(' ') || line.startsWith('+') ? 1 : 0;
    const candidate = [...lines, ...unit];
    const candidateText = renderSubHunk(oldStart, oldCount + unitOld, newStart, newCount + unitNew, heading, candidate);
    if (lines.length > 0 && estimateTokens(candidateText) > capTokens) {
      flush();
      oldStart = oldLine;
      newStart = newLine;
    }
    lines.push(...unit);
    oldCount += unitOld;
    newCount += unitNew;
    oldLine += unitOld;
    newLine += unitNew;
  }
  flush();
  return subHunks;
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
  const old = oldCount > 0 ? oldStart : Math.max(0, oldStart - 1);
  const current = newCount > 0 ? newStart : Math.max(0, newStart - 1);
  return [`@@ -${old},${oldCount} +${current},${newCount} @@${heading}`, ...lines].join('\n');
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
