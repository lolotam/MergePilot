import type { ContextDisclosure } from '@mergepilot/engine';
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
 * (ADR-0029). A disclosure, not an incomplete review: the diff itself was fully reviewed.
 */
export function renderContextNote(context: ContextDisclosure | undefined, isArabic: boolean): string | undefined {
  if (!context) return undefined;
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

/** The context of several panel bots as one disclosure: sent by any bot, left out by all. */
export function mergeContextDisclosures(items: ReadonlyArray<ContextDisclosure | undefined>): ContextDisclosure | undefined {
  const present = items.filter((c): c is ContextDisclosure => c !== undefined);
  if (present.length === 0) return undefined;
  const sent = new Set(present.flatMap((c) => c.sent));
  const leftOut = new Set(present.flatMap((c) => c.leftOut).filter((p) => !sent.has(p)));
  return { sent: [...sent], leftOut: [...leftOut] };
}
