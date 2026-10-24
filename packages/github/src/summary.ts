import type { ContextDisclosure, ExplorationDisclosure, Finding, OutputLimitDisclosure, WithheldItem } from '@mergepilot/engine';
import type { FallbackReason } from './fallback-reason.js';
import { renderBotIdentity, type BotIdentity } from './bot-identity.js';
import type { JudgeSummaryInput } from './judge-summary.js';
import {
  renderContextNote,
  renderExplorationNote,
  renderOutputLimitNote,
  renderRulesLeftOut,
  renderVerifyRejected,
  renderWithheld,
  type VerifyRejectedItem,
} from './review-notes.js';
import { neutralize } from './text-safety.js';

export type ReviewScope =
  | { mode: 'incremental'; sinceSha: string; commitCount?: number }
  | { mode: 'full'; reason?: string };

export interface ReviewSummaryInput {
  language: 'ar' | 'en';
  /** The model's overall summary; empty when the review was skipped or failed. */
  summary: string;
  /** Findings that could not be anchored to a diff line. */
  summaryOnly: Finding[];
  inlineCount: number;
  complete: boolean;
  incompleteReasons: string[];
  /** e.g. `anthropic:claude-sonnet-5-5`, shown in the footer. */
  modelLabel: string;
  outcome: 'completed' | 'skipped-budget' | 'failed';
  /** Human-readable reason when outcome is not `completed`. */
  reason?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Set when an explicit fallback model answered instead of the configured one (ADR-0008);
   * `modelLabel` is then the fallback model. Always disclosed in the summary.
   */
  fallback?: FallbackReason;
  /** Review scope (incremental vs full). */
  scope?: ReviewScope;
  /** The Jev judge's disclosure (ADR-0015): who answered, failures, filtered findings. */
  judge?: JudgeSummaryInput | undefined;
  /** The reviewer-panel bot (ADR-0017); when set, the summary starts with its identity line. */
  identity?: BotIdentity | undefined;
  /** Findings the verification pass rejected (ADR-0028), listed folded. */
  verifyRejected?: readonly VerifyRejectedItem[] | undefined;
  /** What the model noticed and did not report (ADR-0042), listed folded. */
  withheld?: readonly WithheldItem[] | undefined;
  /** Nested rules files left out of the review (ADR-0028). */
  rulesLeftOut?: readonly string[] | undefined;
  /** Repository context sent and left out (ADR-0029). */
  context?: ContextDisclosure | undefined;
  /** Read-only exploration before the answer (ADR-0046). */
  exploration?: ExplorationDisclosure | undefined;
  /** The model's output limit clamped the answer budget (ADR-0033). */
  outputLimit?: OutputLimitDisclosure | undefined;
}

function renderHeader(outcome: ReviewSummaryInput['outcome'], isArabic: boolean): string {
  if (outcome === 'completed') {
    return isArabic ? '## مراجعة MergePilot' : '## MergePilot review';
  }
  if (outcome === 'skipped-budget') {
    return isArabic
      ? '## مراجعة MergePilot — تم التخطي (تجاوز الميزانية)'
      : '## MergePilot review — skipped (budget limit reached)';
  }
  return isArabic
    ? '## مراجعة MergePilot — فشلت المراجعة'
    : '## MergePilot review — failed';
}

function getDefaultReason(outcome: ReviewSummaryInput['outcome'], isArabic: boolean): string {
  if (outcome === 'skipped-budget') {
    return isArabic ? 'تم تجاوز الحد الأقصى للميزانية.' : 'Budget limit reached.';
  }
  return isArabic ? 'حدث خطأ أثناء تشغيل المراجعة.' : 'Review execution failed.';
}

function renderNotCompletedNotice(
  outcome: ReviewSummaryInput['outcome'],
  reason: string | undefined,
  isArabic: boolean,
): string {
  const defaultReason = getDefaultReason(outcome, isArabic);
  const effectiveReason = neutralize((reason && reason.trim()) || defaultReason);
  if (isArabic) {
    return `> **السبب:** ${effectiveReason}\n>\n> لم تتم مراجعة أي كود.`;
  }
  return `> **Reason:** ${effectiveReason}\n>\n> No code was reviewed.`;
}

function renderFallbackLine(input: ReviewSummaryInput, isArabic: boolean): string {
  return renderFallbackNotice(input.modelLabel, input.fallback ?? { from: '', code: '' }, isArabic);
}

/** «Fallback model X was used because Y failed (code: provider answer)», neutralized. */
export function renderFallbackNotice(modelLabel: string, fallback: FallbackReason, isArabic: boolean): string {
  const used = neutralize(modelLabel);
  const from = neutralize(fallback.from);
  const code = neutralize(fallback.code);
  const detail = fallback.detail ? neutralize(fallback.detail) : '';
  const why = detail ? `${code}: ${detail}` : code;
  // ADR-0027: the same model continued on its other auth method, so name the method, not a model.
  if (fallback.fromMethod && fallback.usedMethod && fallback.fromMethod !== fallback.usedMethod && modelLabel === fallback.from) {
    return renderMethodNotice(used, why, fallback.usedMethod, isArabic);
  }
  return isArabic
    ? `> ⚠️ استُخدم النموذج الاحتياطي \`${used}\` لأن \`${from}\` فشل (${why})`
    : `> ⚠️ Fallback model \`${used}\` was used because \`${from}\` failed (${why})`;
}

/** «The review continued on X with an API key / the subscription because the other hit its limit». */
function renderMethodNotice(used: string, why: string, usedMethod: 'subscription' | 'api-key', isArabic: boolean): string {
  if (usedMethod === 'api-key') {
    return isArabic
      ? `> ⚠️ تابعت المراجعة على \`${used}\` بمفتاح API لأن الاشتراك بلغ حد الحصة أو معدل الطلبات (${why}). تُحتسب هذه الاستدعاءات ضمن الميزانية الشهرية.`
      : `> ⚠️ The review continued on \`${used}\` with an API key because the subscription hit its quota or rate limit (${why}). Those calls count toward the monthly budget.`;
  }
  return isArabic
    ? `> ⚠️ تابعت المراجعة على \`${used}\` بالاشتراك لأن مفاتيح API بلغت حد الحصة أو معدل الطلبات (${why}).`
    : `> ⚠️ The review continued on \`${used}\` with the subscription because the API keys hit their quota or rate limit (${why}).`;
}

/** The review scope line (incremental since a commit, or a full review and why). */
export function renderScopeLine(scope: ReviewScope, isArabic: boolean): string {
  if (scope.mode === 'incremental') {
    const count = scope.commitCount ?? 1;
    const shortSha = scope.sinceSha.slice(0, 7);
    if (isArabic) {
      return `> تمت مراجعة ${count} من الالتزامات الجديدة منذ \`${shortSha}\``;
    }
    const plural = count === 1 ? '1 new commit' : `${count} new commits`;
    return `> Reviewed ${plural} since \`${shortSha}\``;
  }

  if (isArabic) {
    return scope.reason ? `> مراجعة كاملة (${neutralize(scope.reason)})` : '> مراجعة كاملة';
  }
  return scope.reason ? `> Full review (${neutralize(scope.reason)})` : '> Full review';
}

function renderFindingsOutsideDiff(findings: Finding[], isArabic: boolean): string {
  const heading = isArabic ? '### ملاحظات خارج التغييرات' : '### Findings outside the diff';
  const detailsLabel = isArabic ? 'التفاصيل' : 'Details';

  const items = findings.map((f) => {
    const title = neutralize(f.title.trim());
    const body = neutralize(f.body.trim());
    return `**${f.severity}** · \`${f.path}:${f.line}\` — ${title}\n<details>\n<summary>${detailsLabel}</summary>\n\n${body}\n</details>`;
  });

  return `${heading}\n\n${items.join('\n\n')}`;
}

function renderCountsLine(inlineCount: number, summaryOnlyCount: number, isArabic: boolean): string {
  if (isArabic) {
    return `تعليقات مضمنة: ${inlineCount} · خارج التغييرات: ${summaryOnlyCount}`;
  }
  return `Inline comments: ${inlineCount} · Outside diff: ${summaryOnlyCount}`;
}

function renderIncompleteWarning(reasons: string[], isArabic: boolean): string {
  const heading = isArabic ? '### ⚠️ تحذير: مراجعة غير مكتملة' : '### ⚠️ Warning: Incomplete review';
  if (reasons.length === 0) {
    const fallback = isArabic
      ? '- تعذر فحص كامل التغييرات في هذا الطلب.'
      : '- The review could not inspect the entire changeset.';
    return `${heading}\n\n${fallback}`;
  }
  const list = reasons.map((r) => `- ${neutralize(r.trim())}`).join('\n');
  return `${heading}\n\n${list}`;
}

function renderJudge(judge: JudgeSummaryInput, isArabic: boolean): string | undefined {
  const lines: string[] = [];
  if (judge.answeredBy) lines.push(`> Jev: \`${neutralize(judge.answeredBy)}\``);
  if (judge.uses) {
    const list = judge.uses.length > 0 ? judge.uses.map((use) => `\`${use}\``).join(isArabic ? '، ' : ', ') : '—';
    lines.push(isArabic ? `> استخدامات Jev: ${list}` : `> Jev uses: ${list}`);
  }
  if (judge.unavailable) {
    const code = neutralize(judge.unavailable);
    lines.push(
      isArabic
        ? `> ⚠️ حَكَم Jev غير متاح: ${code} — نُشرت الملاحظات من غير فلترة`
        : `> ⚠️ Jev judge unavailable: ${code} — findings were published unfiltered`,
    );
  }
  if (judge.duplicatesUnavailable) {
    const code = neutralize(judge.duplicatesUnavailable);
    lines.push(
      isArabic
        ? `> ⚠️ فحص التكرار بالمعنى (Jev) غير متاح: ${code}`
        : `> ⚠️ Jev duplicate check unavailable: ${code}`,
    );
  }
  const filtered = judge.filtered ?? [];
  if (filtered.length > 0) {
    const label = isArabic ? `استبعدها Jev (${filtered.length})` : `Filtered by Jev (${filtered.length})`;
    const items = filtered.map(
      (f) => `- ${neutralize(f.title.trim())} · \`${neutralize(f.path)}:${f.line}\` · ${f.noul.toFixed(2)}`,
    );
    lines.push(`<details>\n<summary>${label}</summary>\n\n${items.join('\n')}\n</details>`);
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function renderFooter(input: ReviewSummaryInput, isArabic: boolean): string {
  const modelText = isArabic
    ? `النموذج: \`${input.modelLabel}\``
    : `Model: \`${input.modelLabel}\``;

  const parts: string[] = [modelText];

  const hasCost = typeof input.costUsd === 'number';
  const hasTokens = typeof input.inputTokens === 'number' || typeof input.outputTokens === 'number';

  if (hasCost && hasTokens) {
    const costStr = `$${input.costUsd!.toFixed(4)}`;
    const inTokens = (input.inputTokens ?? 0).toLocaleString('en-US');
    const outTokens = (input.outputTokens ?? 0).toLocaleString('en-US');
    if (isArabic) {
      parts.push(`التكلفة: ${costStr} (${inTokens} مدخلات / ${outTokens} مخرجات)`);
    } else {
      parts.push(`Cost: ${costStr} (${inTokens} in / ${outTokens} out)`);
    }
  } else if (hasCost) {
    const costStr = `$${input.costUsd!.toFixed(4)}`;
    parts.push(isArabic ? `التكلفة: ${costStr}` : `Cost: ${costStr}`);
  } else if (hasTokens) {
    const inTokens = (input.inputTokens ?? 0).toLocaleString('en-US');
    const outTokens = (input.outputTokens ?? 0).toLocaleString('en-US');
    if (isArabic) {
      parts.push(`التوكنات: ${inTokens} مدخلات / ${outTokens} مخرجات`);
    } else {
      parts.push(`Tokens: ${inTokens} in / ${outTokens} out`);
    }
  }

  const modelLine = parts.join(' · ');
  const disclaimer = isArabic
    ? '`MergePilot` يكتفي بالتعليق فقط ولا يوافق على الدمج أو يمنعه.'
    : 'MergePilot only comments and never approves or blocks merging.';

  return `---\n${modelLine}\n${disclaimer}`;
}

/**
 * Renders the review body posted above the inline comments (task C4 owns the full design).
 * The hidden idempotency marker is appended separately by `publishReview`.
 */
export function renderReviewSummary(input: ReviewSummaryInput): string {
  const isArabic = input.language === 'ar';
  const sections: string[] = [];

  if (input.identity) sections.push(renderBotIdentity(input.identity, input.language === 'ar' ? 'ar' : 'en'));
  sections.push(renderHeader(input.outcome, isArabic));

  if (input.fallback) {
    sections.push(renderFallbackLine(input, isArabic));
  }

  if (input.scope) {
    sections.push(renderScopeLine(input.scope, isArabic));
  }

  if (input.outcome !== 'completed') {
    sections.push(renderNotCompletedNotice(input.outcome, input.reason, isArabic));
  }

  if (input.summary && input.summary.trim().length > 0) {
    sections.push(neutralize(input.summary.trim()));
  }

  if (!input.complete) {
    sections.push(renderIncompleteWarning(input.incompleteReasons, isArabic));
  }

  const judge = input.judge ? renderJudge(input.judge, isArabic) : undefined;
  if (judge) sections.push(judge);

  const rejected = renderVerifyRejected(input.verifyRejected ?? [], isArabic);
  if (rejected) sections.push(rejected);
  const withheld = renderWithheld(input.withheld, isArabic);
  if (withheld) sections.push(withheld);
  const rulesLeftOut = renderRulesLeftOut(input.rulesLeftOut ?? [], isArabic);
  if (rulesLeftOut) sections.push(rulesLeftOut);
  const contextNote = renderContextNote(input.context, isArabic);
  if (contextNote) sections.push(contextNote);
  const explorationNote = renderExplorationNote(input.exploration, isArabic);
  if (explorationNote) sections.push(explorationNote);
  const outputLimitNote = renderOutputLimitNote(input.outputLimit, isArabic);
  if (outputLimitNote) sections.push(outputLimitNote);

  if (input.summaryOnly && input.summaryOnly.length > 0) {
    sections.push(renderFindingsOutsideDiff(input.summaryOnly, isArabic));
  }

  if (input.outcome === 'completed' || input.inlineCount > 0 || input.summaryOnly.length > 0) {
    sections.push(renderCountsLine(input.inlineCount, input.summaryOnly?.length ?? 0, isArabic));
  }

  sections.push(renderFooter(input, isArabic));

  const content = sections.join('\n\n');

  if (isArabic) {
    return `<div dir="rtl">\n\n${content}\n\n</div>`;
  }

  return content;
}
