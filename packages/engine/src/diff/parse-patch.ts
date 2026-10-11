export interface HunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ParsedPatch {
  hunks: HunkHeader[];
  rightLines: Set<number>;
  leftLines: Set<number>;
  addedLines: Set<number>;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified diff text for a single file as returned by GitHub's `files[].patch`.
 * Tracks hunks and sets of valid line numbers on both sides of the diff.
 */
export function parsePatch(patch: string): ParsedPatch {
  const hunks: HunkHeader[] = [];
  const rightLines = new Set<number>();
  const leftLines = new Set<number>();
  const addedLines = new Set<number>();

  if (!patch || !patch.trim()) {
    return { hunks, rightLines, leftLines, addedLines };
  }

  const lines = patch.split(/\r?\n/);
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(HUNK_HEADER_RE);
      if (match) {
        const oldStartStr = match[1];
        const oldLinesStr = match[2];
        const newStartStr = match[3];
        const newLinesStr = match[4];

        if (oldStartStr !== undefined && newStartStr !== undefined) {
          const oldStart = parseInt(oldStartStr, 10);
          const oldLines = oldLinesStr !== undefined ? parseInt(oldLinesStr, 10) : 1;
          const newStart = parseInt(newStartStr, 10);
          const newLines = newLinesStr !== undefined ? parseInt(newLinesStr, 10) : 1;

          hunks.push({ oldStart, oldLines, newStart, newLines });
          oldLine = oldStart;
          newLine = newStart;
          inHunk = true;
          continue;
        }
      }
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+')) {
      rightLines.add(newLine);
      addedLines.add(newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      leftLines.add(oldLine);
      oldLine++;
    } else if (line.startsWith(' ')) {
      leftLines.add(oldLine);
      rightLines.add(newLine);
      oldLine++;
      newLine++;
    } else if (line.startsWith('\\')) {
      // E.g. '\ No newline at end of file' — diff metadata, ignored
      continue;
    }
  }

  return { hunks, rightLines, leftLines, addedLines };
}
