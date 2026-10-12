import type { Finding } from '@mergepilot/engine';
import type { JudgeSummaryInput } from './judge-summary.js';

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
  fallback?: { from: string; code: string };
  /** Review scope (incremental vs full). */
  scope?: ReviewScope;
  /** The Jev judge's disclosure (ADR-0015): who answered, failures, filtered findings. */
  judge?: JudgeSummaryInput | undefined;
}

/**
 * Model and author text is untrusted: it must not forge our idempotency marker, close the
 * RTL wrapper, or @-mention (and so notify) real people or teams.
 */
function neutralize(text: string): string {
  return text
    .replaceAll('<!--', '&lt;!--')
    .replace(/<\/div/gi, '&lt;/div')
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9-])/g, '$1@\u200b');
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
  const used = neutralize(input.modelLabel);
  const from = neutralize(input.fallback?.from ?? '');
  const code = neutralize(input.fallback?.code ?? '');
  return isArabic
    ? `> ⚠️ استُخدم النموذج الاحتياطي \`${used}\` لأن \`${from}\` فشل (${code})`
    : `> ⚠️ Fallback model \`${used}\` was used because \`${from}\` failed (${code})`;
}

function renderScopeLine(scope: ReviewScope, isArabic: boolean): string {
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
