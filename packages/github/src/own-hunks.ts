/**
 * Keeps, from the patch of a file between the last reviewed head and the new head, only the hunks
 * that belong to the PR itself (ADR-0012 amendment). After the author merges the base branch into
 * the PR branch, the compare range also carries the base branch's changes to files the PR touches;
 * those lines are on the base, so they are not in the PR's own diff (base...head) and are dropped.
 * A hunk stays when one of its added or removed lines (ignoring blank lines) is also added or
 * removed in the PR's own patch; a hunk with no non-blank changed line is kept. Without the PR
 * patch (too large for GitHub) nothing is dropped.
 */

/** Non-blank content of the lines a patch adds (`+`) or removes (`-`). */
function changedLines(patch: string, sign: '+' | '-'): Set<string> {
  const lines = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith(sign) || line.startsWith(`${sign}${sign}${sign} `)) continue;
    const content = line.slice(1).trim();
    if (content) lines.add(content);
  }
  return lines;
}

function splitHunks(patch: string): string[] {
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') && current.length > 0) {
      hunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current.join('\n'));
  return hunks.filter((hunk) => hunk.startsWith('@@'));
}

/** The PR's own hunks of `comparePatch`; undefined when none is left; the whole patch without a PR patch. */
export function ownHunks(comparePatch: string, prPatch: string | undefined): string | undefined {
  if (prPatch === undefined) return comparePatch;
  const added = changedLines(prPatch, '+');
  const removed = changedLines(prPatch, '-');
  const kept = splitHunks(comparePatch).filter((hunk) => {
    const changes = hunk
      .split('\n')
      .slice(1)
      .filter((line) => (line.startsWith('+') || line.startsWith('-')) && line.slice(1).trim() !== '');
    // Nothing to compare (only blank-line edits): keep it rather than guess.
    if (changes.length === 0) return true;
    return changes.some((line) => (line.startsWith('+') ? added : removed).has(line.slice(1).trim()));
  });
  return kept.length > 0 ? kept.join('\n') : undefined;
}
