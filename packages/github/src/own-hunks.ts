/**
 * Drops, from the patch of a file between the last reviewed head and the new head, the hunks that
 * a base-branch merge brought in (ADR-0012 amendment). A hunk is dropped only when it is proven to
 * be the base branch's: every non-blank line it adds or removes is added or removed the same way
 * in the base branch's own changes over that range (`basePatch`), and at least one of them is not
 * a change of the PR's own diff (base...head). Anything uncertain is kept and reviewed: dropping a
 * real PR change (a later deletion of an earlier PR edit, say) would hide it, while reviewing an
 * extra base hunk only costs a little noise. Without the base patch nothing is dropped.
 */

type Sign = '+' | '-';

interface Change {
  sign: Sign;
  content: string;
}

/** The non-blank lines a patch (or hunk body) adds and removes, header lines excluded. */
function changesOf(lines: readonly string[]): Change[] {
  const changes: Change[] = [];
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    const content = line.slice(1).trim();
    if (content) changes.push({ sign: line[0] as Sign, content });
  }
  return changes;
}

function changeSet(patch: string | undefined): Set<string> {
  return new Set(changesOf(patch ? patch.split('\n') : []).map((c) => `${c.sign}${c.content}`));
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

/**
 * `comparePatch` without the hunks proven to come from the base branch; undefined when none is
 * left. `basePatch` is the file's patch over the base branch's own changes since the last review,
 * `prPatch` its patch in the PR's own diff (undefined when GitHub omits it).
 */
export function withoutBaseHunks(
  comparePatch: string,
  basePatch: string | undefined,
  prPatch: string | undefined,
): string | undefined {
  if (basePatch === undefined) return comparePatch;
  const base = changeSet(basePatch);
  const pr = changeSet(prPatch);
  const kept = splitHunks(comparePatch).filter((hunk) => {
    const keys = changesOf(hunk.split('\n').slice(1)).map((c) => `${c.sign}${c.content}`);
    if (keys.length === 0) return true;
    const fromBase = keys.every((key) => base.has(key)) && keys.some((key) => !pr.has(key));
    return !fromBase;
  });
  return kept.length > 0 ? kept.join('\n') : undefined;
}
