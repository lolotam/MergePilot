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
