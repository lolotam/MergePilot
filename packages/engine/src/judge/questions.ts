/**
 * Builders for Jev questions and for the untrusted text that goes into `state`. Every piece of
 * PR-derived text is secret-redacted and delimiter-escaped exactly like the review prompts, and is
 * capped, so state holds only what the questions need (TypeSafe's design rules).
 */
import type { Secret } from '../credentials/secret.js';
import { escapeDelimiters } from '../review/delimiters.js';
import { redactSecrets } from '../security/redact.js';
import {
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  type ChoiceQuestion,
  type JudgeInstructions,
  type NoulQuestion,
  type ScoreQuestion,
} from './types.js';

/** Redacted, escaped and capped untrusted text for `state`. */
export function untrustedText(text: string, knownSecrets: readonly Secret[], maxChars = 4000): string {
  const safe = escapeDelimiters(redactSecrets(text, [...knownSecrets]).text);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
}

export function noul(instructions: JudgeInstructions, criteria?: { true: string; false: string }): NoulQuestion {
  return { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
}

export function choice(instructions: JudgeInstructions, criteria: Record<string, string | null>): ChoiceQuestion {
  const count = Object.keys(criteria).length;
  if (count < 1 || count > MAX_CHOICE_OPTIONS) throw new Error(`a choice question takes 1–${MAX_CHOICE_OPTIONS} options`);
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: JudgeInstructions, levels: string[]): ScoreQuestion {
  if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
    throw new Error(`a score question takes ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} levels`);
  }
  return { type: 'score', instructions, criteria: levels };
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The patch hunk whose new-side range holds `line` (the nearest hunk otherwise), so a question
 * sees the code a finding points at without the whole file.
 */
export function hunkAround(patch: string, line: number): string {
  const hunks: Array<{ start: number; end: number; text: string[] }> = [];
  for (const row of patch.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      hunks.push({ start, end: start + Math.max(count, 1) - 1, text: [row] });
    } else {
      hunks.at(-1)?.text.push(row);
    }
  }
  if (hunks.length === 0) return patch;
  const distance = (h: { start: number; end: number }): number =>
    line < h.start ? h.start - line : line > h.end ? line - h.end : 0;
  const best = hunks.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return best.text.join('\n');
}
