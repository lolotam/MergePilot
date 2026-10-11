import type { Finding } from '../review/types.js';
import type { ParsedPatch } from '../diff/parse-patch.js';

export interface AnchoredFindings {
  inline: Finding[];
  summaryOnly: Finding[];
}

/**
 * Anchors findings against parsed file diff patches.
 *
 * A finding is placed into `inline` only when its file path exists in the diff index
 * and its target line is part of the diff on the respective side:
 * - 'RIGHT': line must be present in `patch.rightLines`
 * - 'LEFT': line must be present in `patch.leftLines`
 *
 * If the path is not indexed or the line falls outside the diff hunks (e.g. an unchanged line),
 * the finding is placed into `summaryOnly`.
 */
export function anchorFindings(
  findings: readonly Finding[],
  index: Map<string, ParsedPatch>,
): AnchoredFindings {
  const inline: Finding[] = [];
  const summaryOnly: Finding[] = [];

  for (const finding of findings) {
    const patch = index.get(finding.path);
    if (!patch) {
      summaryOnly.push(finding);
      continue;
    }

    const side = finding.side ?? 'RIGHT';
    const isLineInDiff =
      side === 'LEFT'
        ? patch.leftLines.has(finding.line)
        : patch.rightLines.has(finding.line);

    if (isLineInDiff) {
      inline.push(finding);
    } else {
      summaryOnly.push(finding);
    }
  }

  return { inline, summaryOnly };
}
