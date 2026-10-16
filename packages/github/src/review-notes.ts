import type { ContextDisclosure, ContextPaths } from '@mergepilot/engine';
import { neutralize } from './text-safety.js';

/** A finding the verification pass rejected; `bot` names the panel bot that reported it. */
export interface VerifyRejectedItem {
  title: string;
  path: string;
  line: number;
  bot?: string | undefined;
}

/**
 * «Rejected by verification (N)»: what the verify pass dropped, folded like Jev's filtered list,
 * so a rejection is never silent (ADR-0028).
 */
export function renderVerifyRejected(items: readonly VerifyRejectedItem[], isArabic: boolean): string | undefined {
  if (items.length === 0) return undefined;
  const label = isArabic ? `رفضها التحقق (${items.length})` : `Rejected by verification (${items.length})`;
  const lines = items.map((item) => {
    const bot = item.bot ? ` · _${neutralize(item.bot)}_` : '';
    return `- ${neutralize(item.title.trim())} · \`${neutralize(item.path)}:${item.line}\`${bot}`;
  });
  return `<details>\n<summary>${label}</summary>\n\n${lines.join('\n')}\n</details>`;
}

/**
 * The nested owner rules files the review could not include: over `review.maxRulesTokens`, or in a
 * directory past the lookup limit (ADR-0028). A disclosure, not an incomplete review: the diff
 * itself was fully reviewed.
 */
export function renderRulesLeftOut(paths: readonly string[], isArabic: boolean): string | undefined {
  if (paths.length === 0) return undefined;
  const list = paths.map((p) => `\`${neutralize(p)}\``).join(isArabic ? '، ' : ', ');
  return isArabic
    ? `> ℹ️ ملفات قواعد لم تُرسل مع المراجعة (تجاوزت \`review.maxRulesTokens\` أو حد البحث في المجلدات): ${list}`
    : `> ℹ️ Rules files not sent with the review (over \`review.maxRulesTokens\` or the directory lookup limit): ${list}`;
}

/**
 * «Repository context: N files sent, M left out»: how much code outside the diff the review saw
 * (ADR-0029); on a follow-up review also how much of the rest of the PR it saw and how many open
 * findings it re-checked (ADR-0030). A disclosure, not an incomplete review: the diff itself was
 * fully reviewed.
 */
export function renderContextNote(context: ContextDisclosure | undefined, isArabic: boolean): string | undefined {
  if (!context) return undefined;
  const lines = [
    repositoryContextLine(context, isArabic),
    pullRequestContextLine(context.pr, isArabic),
    openFindingsLine(context.openFindings, isArabic),
  ].filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join('\n>\n') : undefined;
}

function repositoryContextLine(context: ContextPaths, isArabic: boolean): string | undefined {
  const sent = new Set(context.sent).size;
  const leftOut = new Set(context.leftOut).size;
  if (sent === 0 && leftOut === 0) return undefined;
  if (isArabic) {
    const left = leftOut > 0 ? `، وغير المُرسلة ${leftOut} (تجاوزت \`review.contextTokens\` أو حد القراءة)` : '';
    return `> ℹ️ سياق المستودع: الملفات المُرسلة ${sent}${left}.`;
  }
  const left = leftOut > 0 ? `, ${leftOut} left out (over \`review.contextTokens\` or the read limit)` : '';
  return `> ℹ️ Repository context: ${sent} ${sent === 1 ? 'file' : 'files'} sent${left}.`;
}

/** «Rest of the pull request: N other changed files sent» on a follow-up review (ADR-0030). */
function pullRequestContextLine(pr: ContextPaths | undefined, isArabic: boolean): string | undefined {
  if (!pr) return undefined;
  const sent = new Set(pr.sent).size;
  const leftOut = new Set(pr.leftOut).size;
  if (sent === 0 && leftOut === 0) return undefined;
  if (isArabic) {
    const left = leftOut > 0 ? `، وغير المُرسلة ${leftOut} (تجاوزت \`review.prContextTokens\`)` : '';
    return `> ℹ️ باقي الـ PR كسياق: الملفات المتغيرة الأخرى المُرسلة ${sent}${left}.`;
  }
  const left = leftOut > 0 ? `, ${leftOut} left out (over \`review.prContextTokens\`)` : '';
  return `> ℹ️ Rest of the pull request: ${sent} other changed ${sent === 1 ? 'file' : 'files'} sent as context${left}.`;
}

/** How many of the bot's open findings the follow-up review re-checked (ADR-0030). */
function openFindingsLine(open: ContextDisclosure['openFindings'], isArabic: boolean): string | undefined {
  if (!open) return undefined;
  const shown = new Set(open.shown).size;
  if (open.unchecked && shown === 0) {
    return isArabic
      ? '> ℹ️ لم يُعَد فحص الملاحظات المفتوحة: تعذّرت قراءة حالة المحادثات.'
      : '> ℹ️ Open findings were not re-checked: their thread status could not be read.';
  }
  if (shown === 0) return undefined;
  // Over the cap, the count says how many open findings there were: «30 of 45».
  const count = open.total !== undefined && open.total > shown ? `${shown}${isArabic ? ' من ' : ' of '}${open.total}` : `${shown}`;
  if (open.unchecked) {
    // A panel where some bots re-checked and others could not read the thread status.
    return isArabic
      ? `> ℹ️ ملاحظات مفتوحة أُعيد فحصها: ${count}، لكن بعض البوتات تعذّر عليها قراءة حالة المحادثات.`
      : `> ℹ️ Open findings re-checked: ${count}, but some bots could not read their thread status.`;
  }
  return isArabic ? `> ℹ️ ملاحظات مفتوحة أُعيد فحصها: ${count}.` : `> ℹ️ Open findings re-checked: ${count}.`;
}

/** The context of several panel bots as one disclosure: sent by any bot, left out by all. */
export function mergeContextDisclosures(items: ReadonlyArray<ContextDisclosure | undefined>): ContextDisclosure | undefined {
  const present = items.filter((c): c is ContextDisclosure => c !== undefined);
  if (present.length === 0) return undefined;
  const merged: ContextDisclosure = mergePaths(present);
  const prs = present.map((c) => c.pr).filter((p): p is ContextPaths => p !== undefined);
  if (prs.length > 0) merged.pr = mergePaths(prs);
  const opens = present.map((c) => c.openFindings).filter((o) => o !== undefined);
  if (opens.length > 0) {
    const shown = [...new Set(opens.flatMap((o) => o.shown))];
    // One bot that could not re-check is disclosed, even when another could.
    const totals = opens.flatMap((o) => (o.total !== undefined ? [o.total] : []));
    merged.openFindings = {
      shown,
      ...(totals.length > 0 ? { total: Math.max(...totals) } : {}),
      ...(opens.some((o) => o.unchecked) ? { unchecked: true } : {}),
    };
  }
  return merged;
}

function mergePaths(items: readonly ContextPaths[]): ContextPaths {
  const sent = new Set(items.flatMap((c) => c.sent));
  const leftOut = new Set(items.flatMap((c) => c.leftOut).filter((p) => !sent.has(p)));
  return { sent: [...sent], leftOut: [...leftOut] };
}
