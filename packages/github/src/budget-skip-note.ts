import { parseBudgetSkipReason, type BudgetSkipReason } from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import { shortenDetail } from './fallback-reason.js';
import { fetchAllIssueComments } from './pause.js';
import { neutralize } from './text-safety.js';

function budgetSkipMarker(headSha: string): string {
  return `<!-- mergepilot:budget-skip head=${headSha} -->`;
}

export interface BudgetSkipNoteParams {
  owner: string;
  repo: string;
  pull_number: number;
  headSha: string;
  publisherLogin: string;
  language: 'ar' | 'en';
  /** The engine's `skipped-budget` reason, already redacted by the caller. */
  reason: string;
}

/** «about 380k» for a token estimate; the exact count under 1,000. */
function approxTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000).toLocaleString('en-US')}k`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

interface NoteText {
  title: string;
  body: string;
}

function tokenLimitText(skip: Extract<BudgetSkipReason, { kind: 'input-tokens' }>, isArabic: boolean): NoteText {
  const needed = approxTokens(skip.promptTokens);
  const limit = skip.maxInputTokens.toLocaleString('en-US');
  return isArabic
    ? {
        title: 'الـ PR كبير أوي',
        body: `المراجعة محتاجة حوالي ${needed} توكن، والحد ${limit}. قسّم الـ PR لأجزاء أصغر، أو ارفع \`budget.maxInputTokens\` في \`.mergepilot.yml\`.`,
      }
    : {
        title: 'the PR is too large',
        body: `The review needs about ${needed} tokens; the limit is ${limit}. Split the PR into smaller ones, or raise \`budget.maxInputTokens\` in \`.mergepilot.yml\`.`,
      };
}

function costLimitText(skip: Extract<BudgetSkipReason, { kind: 'cost' }>, isArabic: boolean): NoteText {
  return isArabic
    ? {
        title: 'تكلفتها المتوقعة أكبر من ميزانية المراجعة الواحدة',
        body: `التكلفة المتوقعة ${usd(skip.estimatedUsd)}، والحد ${usd(skip.limitUsd)}. ارفع \`budget.perReviewUsd\` في \`.mergepilot.yml\`، أو قسّم الـ PR لأجزاء أصغر.`,
      }
    : {
        title: 'it would cost more than the per-review budget',
        body: `Estimated cost ${usd(skip.estimatedUsd)}; the limit is ${usd(skip.limitUsd)}. Raise \`budget.perReviewUsd\` in \`.mergepilot.yml\`, or split the PR into smaller ones.`,
      };
}

/** A reason the engine did not build with known numbers: quoted on one line, neutralized. */
function otherReasonText(reason: string, isArabic: boolean): NoteText {
  const why = neutralize(shortenDetail(reason));
  return isArabic
    ? { title: 'وصلت لحد في الميزانية', body: `السبب: ${why}` }
    : { title: 'a budget limit was reached', body: `Reason: ${why}` };
}

/** Title and explanation of the note, in plain words, for what the engine reported. */
function noteText(reason: string, isArabic: boolean): NoteText {
  const skip = parseBudgetSkipReason(reason);
  if (skip?.kind === 'input-tokens') return tokenLimitText(skip, isArabic);
  if (skip?.kind === 'cost') return costLimitText(skip, isArabic);
  return otherReasonText(reason, isArabic);
}

/**
 * Says on the PR, once per head, that MergePilot skipped this review because of its budget, why in
 * plain words, and what to change. Without it a consensus panel whose bots all skipped publishes
 * nothing, and the owner never learns why (eyadex#78). Returns whether a note was posted.
 */
export async function postBudgetSkipNoteOnce(client: GitHubClient, params: BudgetSkipNoteParams): Promise<boolean> {
  if (!client.createIssueComment) return false;
  const marker = budgetSkipMarker(params.headSha);
  const comments = await fetchAllIssueComments(client, params);
  if (comments.some((c) => c.user?.login === params.publisherLogin && c.body?.includes(marker))) return false;

  const sha = params.headSha.slice(0, 7);
  const isArabic = params.language === 'ar';
  const { title, body: explanation } = noteText(params.reason, isArabic);
  const body = isArabic
    ? `<div dir="rtl">\n\n> ⚠️ **MergePilot اتخطى مراجعة \`${sha}\`: ${title}**\n>\n> ${explanation}\n>\n> بعدها اكتب \`@mergepilot مراجعة\` عشان تتعمل من جديد.\n\n</div>\n\n${marker}`
    : `> ⚠️ **MergePilot skipped this review of \`${sha}\`: ${title}**\n>\n> ${explanation}\n>\n> After that, comment \`@mergepilot review\` to run it again.\n\n${marker}`;
  await client.createIssueComment({ owner: params.owner, repo: params.repo, issue_number: params.pull_number, body });
  return true;
}
