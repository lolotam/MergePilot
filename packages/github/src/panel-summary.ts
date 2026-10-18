import { escapeInline, renderBotLogo } from './bot-identity.js';
import { foundByLabel, type ConsensusCluster, type MergePanelResult } from './consensus.js';
import type { FallbackReason } from './fallback-reason.js';
import { renderFallbackNotice, renderScopeLine, type ReviewScope } from './summary.js';
import type { ContextDisclosure, OutputLimitDisclosure } from '@mergepilot/engine';
import {
  renderContextNote,
  renderOutputLimitNote,
  renderRulesLeftOut,
  renderVerifyRejected,
  type VerifyRejectedItem,
} from './review-notes.js';
import { neutralize } from './text-safety.js';

/** One bot's row in the consensus summary table (ADR-0017). */
export interface PanelBotRow {
  slot: number;
  name: string;
  logo: string;
  /** `provider:model` of the model that answered (or was configured). */
  modelLabel: string;
  status: 'completed' | 'failed' | 'skipped';
  findings?: number | null | undefined;
  costUsd?: number | null | undefined;
  /** The bot's own summary, shown folded under the table. */
  summary?: string | undefined;
  /** Why a fallback model answered for this bot (`modelLabel` is then the fallback model). */
  fallback?: FallbackReason | undefined;
  /** The name of the bot's review skill (ADR-0034); left out on Default. */
  skill?: string | undefined;
}

export interface PanelSummaryInput {
  language: 'ar' | 'en';
  /** The app's public URL, for the bot logos. */
  baseUrl?: string | undefined;
  bots: PanelBotRow[];
  merge: MergePanelResult;
  minAgreement: number;
  /** Inline comments actually published (after dropping duplicates of earlier comments). */
  inlineCount: number;
  scope?: ReviewScope | undefined;
  /** Why the panel review is incomplete (a bot's file not covered); empty when complete. */
  incompleteReasons?: string[] | undefined;
  /** Code when the judge's same-issue check for the merge was unavailable. */
  judgeUnavailable?: string | undefined;
  /** "provider:model (fallback n; … failed: code)" of the judge entry that answered the merge's checks. */
  judgeAnsweredBy?: string | undefined;
  /** The same, for the check against earlier comments; set only when that check asked the judge. */
  dedupeJudgeAnsweredBy?: string | undefined;
  /** Code when every judge entry failed on the check against earlier comments. */
  dedupeJudgeUnavailable?: string | undefined;
  /** Every bot's findings its verification pass rejected, each naming the bot (ADR-0028). */
  verifyRejected?: readonly VerifyRejectedItem[] | undefined;
  /** Nested rules files left out of the review (ADR-0028). */
  rulesLeftOut?: readonly string[] | undefined;
  /** Repository context of the bots, merged (ADR-0029). */
  context?: ContextDisclosure | undefined;
  /** The bots whose model's output limit clamped their answer budget (ADR-0033). */
  outputLimits?: ReadonlyArray<OutputLimitDisclosure & { bot: string }> | undefined;
}

interface Labels {
  header: string;
  columns: string[];
  /** The Skill column, added after Model only when a bot has a skill (ADR-0034). */
  skillColumn: string;
  status: Record<PanelBotRow['status'], string>;
  agreement: (min: number, total: number) => string;
  judgeUnavailable: (code: string) => string;
  dedupeAnsweredBy: (entry: string) => string;
  dedupeUnavailable: (code: string) => string;
  incomplete: string;
  outside: string;
  below: (n: number) => string;
  overLimit: (n: number) => string;
  summaries: string;
  counts: (inline: number, outside: number) => string;
  disclaimer: string;
}

const EN: Labels = {
  header: '## Review panel',
  columns: ['', 'Bot', 'Model', 'Status', 'Findings', 'Cost'],
  skillColumn: 'Skill',
  status: { completed: '✅ completed', failed: '❌ failed', skipped: '⏭️ skipped' },
  agreement: (min, total) =>
    `> Kept: findings at least ${min} of ${total} bots agree on; critical and high are always kept.`,
  judgeUnavailable: (code) => `> ⚠️ Jev same-issue check unavailable: ${code} — findings were merged by title and wording only`,
  dedupeAnsweredBy: (entry) => `> Jev (earlier comments): \`${entry}\``,
  dedupeUnavailable: (code) => `> ⚠️ Jev duplicate check unavailable: ${code}`,
  incomplete: '### ⚠️ Warning: Incomplete review',
  outside: '### Findings outside the diff',
  below: (n) => `Below agreement (${n})`,
  overLimit: (n) => `Over the findings limit (${n})`,
  summaries: 'Bot summaries',
  counts: (inline, outside) => `Inline comments: ${inline} · Outside diff: ${outside}`,
  disclaimer: 'MergePilot only comments and never approves or blocks merging.',
};

const AR: Labels = {
  header: '## لوحة المراجعين',
  columns: ['', 'المراجع', 'النموذج', 'الحالة', 'الملاحظات', 'التكلفة'],
  skillColumn: 'المهارة',
  status: { completed: '✅ اكتملت', failed: '❌ فشلت', skipped: '⏭️ تم التخطي' },
  agreement: (min, total) =>
    `> المعروض: الملاحظات التي اتفق عليها ${min} من ${total} مراجعين على الأقل؛ الملاحظات الحرجة والعالية تُعرض دائمًا.`,
  judgeUnavailable: (code) => `> ⚠️ فحص Jev لنفس المشكلة غير متاح: ${code} — تم الدمج بالعنوان والصياغة فقط`,
  dedupeAnsweredBy: (entry) => `> Jev (التعليقات السابقة): \`${entry}\``,
  dedupeUnavailable: (code) => `> ⚠️ فحص التكرار بالمعنى (Jev) غير متاح: ${code}`,
  incomplete: '### ⚠️ تحذير: مراجعة غير مكتملة',
  outside: '### ملاحظات خارج التغييرات',
  below: (n) => `أقل من حد الاتفاق (${n})`,
  overLimit: (n) => `فوق الحد الأقصى للملاحظات (${n})`,
  summaries: 'ملخصات المراجعين',
  counts: (inline, outside) => `تعليقات مضمنة: ${inline} · خارج التغييرات: ${outside}`,
  disclaimer: '`MergePilot` يكتفي بالتعليق فقط ولا يوافق على الدمج أو يمنعه.',
};

const cell = (text: string): string => text.replace(/[|`\r\n]/g, ' ').trim();

function renderTable(input: PanelSummaryInput, labels: Labels): string {
  // The Skill column appears only when a bot has a skill, so a panel without skills reads as before.
  const withSkill = input.bots.some((bot) => bot.skill);
  const columns = withSkill ? [...labels.columns.slice(0, 3), labels.skillColumn, ...labels.columns.slice(3)] : labels.columns;
  const head = `| ${columns.join(' | ')} |`;
  const rule = `|${columns.map(() => '---').join('|')}|`;
  const rows = input.bots.map((bot) => {
    const findings = typeof bot.findings === 'number' ? String(bot.findings) : '—';
    const cost = typeof bot.costUsd === 'number' ? `$${bot.costUsd.toFixed(4)}` : '—';
    const logo = renderBotLogo(input.baseUrl, bot.logo);
    const skill = withSkill ? ` ${bot.skill ? escapeInline(bot.skill) : '—'} |` : '';
    return `| ${logo} | **${escapeInline(bot.name)}** | \`${cell(bot.modelLabel)}\` |${skill} ${labels.status[bot.status]} | ${findings} | ${cost} |`;
  });
  return [head, rule, ...rows].join('\n');
}

function clusterLine(cluster: ConsensusCluster, total: number, language: 'ar' | 'en'): string {
  const f = cluster.finding;
  return `**${f.severity}** · \`${neutralize(f.path)}:${f.line}\` — ${neutralize(f.title.trim())} · _${foundByLabel(cluster, total, language)}_`;
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
}

/**
 * The body of the one review a consensus panel publishes: the «Review panel» header, a table of
 * the bots, the merged findings outside the diff, and everything set aside below the agreement or
 * over the findings limit, so nothing is dropped silently. The hidden marker is appended by `publishReview`.
 */
export function renderPanelSummary(input: PanelSummaryInput): string {
  const isArabic = input.language === 'ar';
  const labels = isArabic ? AR : EN;
  const { merge } = input;
  const sections: string[] = [labels.header];

  if (input.scope) sections.push(renderScopeLine(input.scope, isArabic));
  sections.push(renderTable(input, labels));
  for (const bot of input.bots) {
    // A failed bot's row already says it failed; the notice is for a fallback that answered.
    if (bot.fallback && bot.status === 'completed') sections.push(`${renderFallbackNotice(bot.modelLabel, bot.fallback, isArabic)} — **${escapeInline(bot.name)}**`);
  }
  if (input.minAgreement > 1) sections.push(labels.agreement(input.minAgreement, merge.total));
  if (input.judgeAnsweredBy) sections.push(`> Jev: \`${neutralize(input.judgeAnsweredBy)}\``);
  if (input.dedupeJudgeAnsweredBy) sections.push(labels.dedupeAnsweredBy(neutralize(input.dedupeJudgeAnsweredBy)));
  if (input.dedupeJudgeUnavailable) sections.push(labels.dedupeUnavailable(neutralize(input.dedupeJudgeUnavailable)));
  if (input.judgeUnavailable) sections.push(labels.judgeUnavailable(neutralize(input.judgeUnavailable)));

  const reasons = input.incompleteReasons ?? [];
  if (reasons.length > 0) {
    sections.push(`${labels.incomplete}\n\n${reasons.map((r) => `- ${neutralize(r.trim())}`).join('\n')}`);
  }

  const outside = merge.kept.filter((c) => c.kind === 'summaryOnly');
  if (outside.length > 0) {
    const items = outside.map(
      (c) => `${clusterLine(c, merge.total, input.language)}\n\n${neutralize(c.finding.body.trim())}`,
    );
    sections.push(`${labels.outside}\n\n${items.join('\n\n')}`);
  }

  if (merge.below.length > 0) {
    const items = merge.below.map((c) => `- ${clusterLine(c, merge.total, input.language)}`);
    sections.push(details(labels.below(merge.below.length), items.join('\n')));
  }
  if (merge.overLimit.length > 0) {
    const items = merge.overLimit.map((c) => `- ${clusterLine(c, merge.total, input.language)}`);
    sections.push(details(labels.overLimit(merge.overLimit.length), items.join('\n')));
  }

  const rejected = renderVerifyRejected(input.verifyRejected ?? [], isArabic);
  if (rejected) sections.push(rejected);
  const rulesLeftOut = renderRulesLeftOut(input.rulesLeftOut ?? [], isArabic);
  if (rulesLeftOut) sections.push(rulesLeftOut);
  const contextNote = renderContextNote(input.context, isArabic);
  if (contextNote) sections.push(contextNote);
  for (const limit of input.outputLimits ?? []) {
    const note = renderOutputLimitNote(limit, isArabic, limit.bot);
    if (note) sections.push(note);
  }

  const summaries = input.bots.filter((b) => b.status === 'completed' && b.summary?.trim());
  if (summaries.length > 0) {
    const items = summaries.map((b) => `**${escapeInline(b.name)}**\n\n${neutralize(b.summary!.trim())}`);
    sections.push(details(labels.summaries, items.join('\n\n')));
  }

  sections.push(labels.counts(input.inlineCount, outside.length));
  sections.push(`---\n${labels.disclaimer}`);

  const content = sections.join('\n\n');
  return isArabic ? `<div dir="rtl">\n\n${content}\n\n</div>` : content;
}
