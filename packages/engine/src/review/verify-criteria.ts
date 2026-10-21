/**
 * The owner's rules for the verifier (ADR-0044): the same REVIEW_CRITERIA blocks the review prompt
 * carries, capped in tokens, so a finding that cites a rule can be checked against the rule's text.
 */

import { cutToTokens, estimateTokens } from './budget.js';
import { matchingPathInstructions, wrapCriteria, type PathInstruction } from './prompt.js';

/** Estimated tokens of REVIEW_CRITERIA text the verifier is shown in total. */
export const VERIFY_CRITERIA_TOKENS = 4000;

/** The visible marker a rules block that did not fit ends with. */
const CRITERIA_CUT_MARKER = '[verification limit: the rest of this rules block was not shown]';

/** Below this many tokens left, a block that does not fit is left out instead of cut. */
const MIN_CUT_TOKENS = 200;

export interface VerifyCriteria {
  /** The rendered REVIEW_CRITERIA blocks, in the order they are shown. */
  blocks: string[];
  /** What a ruleRef may name to point at a shown block. */
  names: string[];
}

/** One rule source: a rules file or a path instruction, with the names it may be cited by. */
interface CriteriaSource {
  label: string;
  content: string;
  names: string[];
}

/** The names a rules file may be cited by: its path and its file name. */
function rulesFileNames(path: string): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === path ? [path] : [path, base];
}

/** The names a path instruction may be cited by: its glob and the config file it comes from. */
function pathInstructionNames(glob: string): string[] {
  return [glob, '.mergepilot.yml'];
}

/**
 * The owner's rules for the verifier: the rules files, then the path instructions whose glob
 * matches a changed file, capped in tokens. A block that does not fit is cut to what is left, and
 * a source that is not shown adds no name: a ruleRef naming it gets no exception.
 */
export function buildVerifyCriteria(
  rulesFiles: readonly { path: string; content: string }[],
  pathInstructions: readonly PathInstruction[],
  filePaths: string[],
  maxTokens: number,
): VerifyCriteria {
  const sources: CriteriaSource[] = [];
  for (const rf of rulesFiles) {
    sources.push({ label: `RULES_FILE:${rf.path}`, content: rf.content, names: rulesFileNames(rf.path) });
  }
  for (const pi of matchingPathInstructions([...pathInstructions], filePaths)) {
    sources.push({
      label: `PATH_INSTRUCTIONS:${pi.path}`,
      content: pi.instructions,
      names: pathInstructionNames(pi.path),
    });
  }

  const blocks: string[] = [];
  const names: string[] = [];
  let left = maxTokens;
  for (const source of sources) {
    const full = wrapCriteria(source.label, source.content);
    const cost = estimateTokens(full);
    if (cost <= left) {
      blocks.push(full);
      names.push(...source.names);
      left -= cost;
      continue;
    }
    // Too little left for a cut block to be worth showing: the rest of the rules stay unshown.
    if (left < MIN_CUT_TOKENS) break;
    const overhead = estimateTokens(wrapCriteria(source.label, ''));
    const cut = wrapCriteria(source.label, cutToTokens(source.content, left - overhead, CRITERIA_CUT_MARKER));
    blocks.push(cut);
    names.push(...source.names);
    break;
  }

  return { blocks, names: [...new Set(names)] };
}

/** True when the ruleRef names one of the rules shown to the verifier. */
export function namesShownRule(ruleRef: string, names: readonly string[]): boolean {
  const ref = ruleRef.toLowerCase();
  return names.some((name) => ref.includes(name.toLowerCase()));
}
