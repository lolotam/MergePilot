/**
 * Follow-up reviews (ADR-0030): an incremental run reviews the changes since the last reviewed
 * head, but the model is told the truth about it and sees the rest of the pull request: the PR's
 * other changed files as PR_CONTEXT (through the context plan) and the bot's own findings whose
 * threads are still open, so it can say which ones the new changes fix and not repeat them.
 *
 * The follow-up rides on the prompt's `pr` input, so every call of the review, batches and
 * recovery batches included, is built with it.
 *
 * Pure engine code: the open findings arrive through `RunReviewInput.followUp`.
 */

import type { Secret } from '../credentials/secret.js';
import { redactSecrets } from '../security/redact.js';
import type { ReviewSkill } from './skill.js';

/** One of the bot's own inline findings from an earlier commit whose thread is still open. */
export interface OpenFinding {
  /** The GitHub comment id: the disclosures of several panel bots merge on it. */
  id: string;
  path: string;
  /** The line the comment is on now; undefined when that line left the diff (outdated thread). */
  line?: number | undefined;
  title: string;
  body: string;
}

/** What makes a review a follow-up: the head reviewed before and the bot's still-open findings. */
export interface FollowUp {
  /** The head commit the previous review covered. */
  sinceSha: string;
  openFindings: OpenFinding[];
}

/**
 * The pull request as a prompt sees it; `followUp` is set on an incremental run only. `skill` is the
 * bot's review skill (ADR-0034): it rides here, like the follow-up, so every review call of the run
 * (whole-PR, batches, truncation recovery) gets it.
 */
export interface PromptPr {
  title: string;
  body: string;
  followUp?: FollowUp | undefined;
  skill?: ReviewSkill | undefined;
}

/** At most this many open findings are shown; the caller keeps the most relevant first. */
export const OPEN_FINDINGS_MAX = 30;
/** An open finding's body is cut to this many characters: a reminder, not the whole comment. */
export const OPEN_FINDING_BODY_MAX_CHARS = 300;
const OPEN_FINDING_TITLE_MAX_CHARS = 160;

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The pull request for every prompt of a review, with the follow-up and the skill when set. */
export function promptPrOf(
  title: string,
  body: string,
  followUp: FollowUp | undefined,
  skill?: ReviewSkill | undefined,
): PromptPr {
  return { title, body, ...(followUp ? { followUp } : {}), ...(skill ? { skill } : {}) };
}

/**
 * The follow-up as the prompts show it: open findings capped, cut and secret-redacted with the
 * review's known secrets. Their text came from earlier model answers about PR-controlled code.
 */
export function prepareFollowUp(followUp: FollowUp | undefined, knownSecrets: Secret[]): FollowUp | undefined {
  if (!followUp) return undefined;
  const redact = (text: string): string => redactSecrets(text, knownSecrets).text;
  return {
    sinceSha: followUp.sinceSha,
    openFindings: followUp.openFindings.slice(0, OPEN_FINDINGS_MAX).map((f) => ({
      id: f.id,
      path: f.path,
      ...(f.line !== undefined ? { line: f.line } : {}),
      title: cut(redact(f.title), OPEN_FINDING_TITLE_MAX_CHARS),
      body: cut(redact(f.body), OPEN_FINDING_BODY_MAX_CHARS),
    })),
  };
}

/**
 * The short form of the reviewed head for the system prompt: hex only, so text from a review
 * marker can never carry instructions into it.
 */
export function shortSha(sha: string): string {
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : 'the last reviewed commit';
}

/** "What you see" on a follow-up review (ADR-0030), plus the fix re-check (ADR-0043). */
export function followUpWhatYouSee(followUp: FollowUp): string {
  const since = shortSha(followUp.sinceSha);
  return `\
WHAT YOU SEE: this is a follow-up review of the changes pushed since ${since}, which was already \
reviewed. PATCH blocks hold only those new changes (or a batch of them), each line printed with its \
line number (new-file numbers for added and context lines, old-file numbers for removed lines). The \
rest of the pull request is shown as read-only context: PR_CONTEXT blocks hold the pull request's own \
diff of other files it changes, numbered the same way, and REPOSITORY_CONTEXT blocks hold files of \
the repository at the head commit, numbered from line 1. You also see the pull request's title and \
description, the owner's rules, sometimes library docs, and sometimes an OPEN_FINDINGS block: \
findings posted on earlier commits whose threads are still open. You never see the program running.

FOLLOW-UP: report problems the new changes cause or reveal anywhere in the pull request, anchored \
in the new changes: "path" is a file with a PATCH block and "line" a number printed in it; code from \
PR_CONTEXT may be quoted in "evidence". Judge an open finding only from the code shown: when the new \
changes fix one, mention that in the summary; never report an open finding again as a new finding.

FIX RE-CHECK: for each guard, condition or error path the new changes add or alter, ask what it \
newly allows, what it newly rejects or breaks, and which partial-failure or retry path runs when it \
fires. A fix that moves a defect is still a defect.`;
}

/** The OPEN_FINDINGS block body: one line per open finding. */
export function renderOpenFindings(findings: readonly OpenFinding[]): string {
  return findings
    .map((f) => {
      const where = f.line !== undefined ? `${f.path}:${f.line}` : `${f.path} (line no longer in the diff)`;
      return `- ${where} — ${f.title}${f.body ? `: ${f.body}` : ''}`;
    })
    .join('\n');
}
