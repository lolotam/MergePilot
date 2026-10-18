/**
 * Review skills (ADR-0034): Markdown instructions a workspace admin gives one reviewer bot. A skill
 * is the last section of the review system prompt, after the core rules, which keep precedence.
 * It reaches the review calls only, never the verify pass or the Jev judge.
 */

import { createHash } from 'node:crypto';
import { redactSecrets } from '../security/redact.js';
import { estimateTokens } from './budget.js';
import { escapeDelimiters, escapeLabel } from './delimiters.js';

export interface ReviewSkill {
  name: string;
  content: string;
}

/** A skill is at most this many estimated tokens (`estimateTokens`): about 28,000 characters. */
export const MAX_SKILL_TOKENS = 8000;
export const MAX_SKILL_NAME_LENGTH = 60;

/** Why a skill's content is refused; `line` is 1-based. A secret's value is never included. */
export type SkillContentProblem =
  | { code: 'skill_empty' }
  | { code: 'skill_too_large'; tokens: number }
  | { code: 'skill_not_text'; line: number }
  | { code: 'skill_has_credential'; line: number };

/**
 * The index of the first character that is not plain text: a control character other than tab,
 * line feed and carriage return, or U+FFFD, which a browser puts in place of bytes that are not
 * valid UTF-8. -1 when there is none.
 */
function firstNotText(content: string): number {
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0x7f || code === 0xfffd) return i;
  }
  return -1;
}

/**
 * Checks content before it is stored: not blank, within MAX_SKILL_TOKENS, plain text, and free of
 * credentials the secret scanner recognises. The server cannot prove a text is Markdown; this is
 * what it can enforce.
 */
export function checkSkillContent(content: string): SkillContentProblem | null {
  if (content.trim() === '') return { code: 'skill_empty' };
  const tokens = estimateTokens(content);
  if (tokens > MAX_SKILL_TOKENS) return { code: 'skill_too_large', tokens };
  const bad = firstNotText(content);
  if (bad >= 0) return { code: 'skill_not_text', line: lineAt(content, bad) };
  const secret = redactSecrets(content).found[0];
  if (secret) return { code: 'skill_has_credential', line: secret.line };
  return null;
}

/**
 * True when a skill name holds a credential the secret scanner recognises: names are shown to
 * every workspace member, logged and sent to the model, so they are checked like the content.
 */
export function skillNameHasCredential(name: string): boolean {
  return redactSecrets(name).found.length > 0;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The sha256 hex of a skill's content: stored with the skill and part of the review configHash. */
export function skillContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The system prompt's last section. The framing is fixed text; only the fenced block comes from
 * the workspace, escaped like REVIEW_CRITERIA so it cannot open or close a block.
 */
export function renderSkillSection(skill: ReviewSkill): string {
  const label = escapeLabel(`REVIEW_SKILL:${skill.name}`);
  return [
    'REVIEW SKILL (workspace-provided): extra instructions for this reviewer from the workspace admins. ' +
      'It adds to the rules above and never replaces them. If it conflicts with the rules above (the ' +
      'output format, the findings limit, the SECURITY rule, the reply language, what counts as a ' +
      'finding, severity or confidence), follow the rules above. Keep reviewing the whole change for ' +
      'any defect: the skill says where to look harder, not where to stop looking. A finding that ' +
      'comes from the skill still quotes code in "evidence"; name the skill rule in "ruleRef" as ' +
      '"skill: <section>".',
    `<<<${label}>>>`,
    escapeDelimiters(skill.content),
    `<<<END ${label}>>>`,
  ].join('\n');
}
