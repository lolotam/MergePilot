import type { Finding } from './types.js';

/** Builds a security Finding for a redacted secret on an added line. */
export function makeRedactionFinding(
  path: string,
  line: number,
  kind: string,
  idIndex: number,
): Finding {
  return {
    id: `sec${idIndex}`,
    path,
    line,
    side: 'RIGHT',
    title: 'Secret detected in patch',
    body: `A secret of kind "${kind}" was detected in this added line and redacted before review.`,
    severity: 'high',
    category: 'security',
    evidence: `[REDACTED:${kind}]`,
    confidence: 1,
  };
}

/**
 * Builds a map from 1-based patch-text line number → new-side file line number
 * for every added or context line in the patch. Used to correlate `redactSecrets`
 * findings (which use patch-text line numbers) with file line numbers.
 */
export function buildPatchLineToNewLineMap(patch: string): Map<number, number> {
  const result = new Map<number, number>();
  const lines = patch.split('\n');
  let patchLineNum = 1;
  let newLine = 0;
  const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(HUNK_RE);
      if (m) {
        newLine = parseInt(m[1] ?? '1', 10);
      }
      patchLineNum++;
      continue;
    }
    if (line.startsWith('+')) {
      result.set(patchLineNum, newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      // removed lines don't have a new-side line number
    } else if (line.startsWith(' ')) {
      result.set(patchLineNum, newLine);
      newLine++;
    }
    patchLineNum++;
  }
  return result;
}
