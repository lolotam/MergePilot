import type { Finding, Severity } from '../review/types.js';
import type { RenderAuditReportInput } from './types.js';

function neutralize(text: string): string {
  return text
    .replaceAll('<!--', '&lt;!--')
    .replace(/<\/div/gi, '&lt;/div')
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9-])/g, '$1@\u200b');
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_LABELS: Record<'ar' | 'en', Record<Severity, string>> = {
  ar: {
    critical: 'حرجة (Critical)',
    high: 'عالية (High)',
    medium: 'متوسطة (Medium)',
    low: 'منخفضة (Low)',
    info: 'معلومات (Info)',
  },
  en: {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    info: 'Info',
  },
};

export function renderAuditReport(input: RenderAuditReportInput): string {
  const isArabic = input.language === 'ar';
  const langKey = isArabic ? 'ar' : 'en';
  const { result, modelLabel } = input;

  const sections: string[] = [];

  // Header
  sections.push(isArabic ? '## فحص MergePilot للمستودع' : '## MergePilot repository audit');

  // Summary
  const validSummaries = result.summaryByChunk.filter(
    (c) => typeof c.summary === 'string' && c.summary.trim().length > 0,
  );

  if (validSummaries.length > 0) {
    const summaryHeading = isArabic ? '### الملخص' : '### Summary';
    const summaryContent =
      validSummaries.length === 1
        ? neutralize(validSummaries[0]!.summary!.trim())
        : validSummaries
            .map(
              (c) =>
                `**${isArabic ? `الجزء ${c.chunkIndex + 1}` : `Part ${c.chunkIndex + 1}`}:** ${neutralize(c.summary!.trim())}`,
            )
            .join('\n\n');
    sections.push(`${summaryHeading}\n\n${summaryContent}`);
  }

  // Findings grouped by severity with path:line
  const findingsHeading = isArabic ? '### الملاحظات' : '### Findings';
  if (result.findings.length === 0) {
    const noFindingsMsg = isArabic
      ? 'لم يتم العثور على أي ملاحظات.'
      : 'No findings.';
    sections.push(`${findingsHeading}\n\n${noFindingsMsg}`);
  } else {
    const findingsBySeverity = new Map<Severity, Finding[]>();
    for (const sev of SEVERITY_ORDER) {
      findingsBySeverity.set(sev, []);
    }
    for (const f of result.findings) {
      const list = findingsBySeverity.get(f.severity);
      if (list) {
        list.push(f);
      }
    }

    const findingSections: string[] = [];
    const detailsLabel = isArabic ? 'التفاصيل' : 'Details';

    for (const sev of SEVERITY_ORDER) {
      const group = findingsBySeverity.get(sev) ?? [];
      if (group.length === 0) continue;

      const label = SEVERITY_LABELS[langKey][sev];
      const items = group.map((f) => {
        const title = neutralize(f.title.trim());
        const body = neutralize(f.body.trim());
        const parts = [body];
        if (f.suggestion && f.suggestion.trim().length > 0) {
          parts.push(`\n\n**${isArabic ? 'اقتراح' : 'Suggestion'}:** ${neutralize(f.suggestion.trim())}`);
        }
        return `**${title}** · \`${f.path}:${f.line}\`\n<details>\n<summary>${detailsLabel}</summary>\n\n${parts.join('')}\n</details>`;
      });

      findingSections.push(`#### ${label} (${group.length})\n\n${items.join('\n\n')}`);
    }

    sections.push(`${findingsHeading}\n\n${findingSections.join('\n\n')}`);
  }

  // Failed chunks
  if (result.failedChunks.length > 0) {
    const failedHeading = isArabic ? '### أجزاء تعذر فحصها' : '### Failed chunks';
    const failedItems = result.failedChunks.map((fc) => {
      const pathsStr = fc.paths.map((p) => `\`${p}\``).join(', ');
      return `- ${isArabic ? `الجزء ${fc.chunkIndex + 1}` : `Chunk ${fc.chunkIndex + 1}`} (${pathsStr}): ${neutralize(fc.error)}`;
    });
    sections.push(`${failedHeading}\n\n${failedItems.join('\n')}`);
  }

  // Skipped files
  if (result.skipped.length > 0) {
    const skippedHeading = isArabic ? '### الملفات المستبعدة' : '### Skipped files';
    const skippedItems = result.skipped.map((s) => `- \`${s.path}\` (${s.reason})`);
    sections.push(`${skippedHeading}\n\n${skippedItems.join('\n')}`);
  }

  // Footer
  const footerParts: string[] = [];
  if (modelLabel) {
    footerParts.push(isArabic ? `النموذج: \`${modelLabel}\`` : `Model: \`${modelLabel}\``);
  }
  if (result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
    const inTokens = result.usage.inputTokens.toLocaleString('en-US');
    const outTokens = result.usage.outputTokens.toLocaleString('en-US');
    footerParts.push(
      isArabic
        ? `التوكنات: ${inTokens} مدخلات / ${outTokens} مخرجات`
        : `Tokens: ${inTokens} in / ${outTokens} out`,
    );
  }

  const disclaimer = isArabic
    ? '`MergePilot` يكتفي بالتعليق فقط ولا يوافق على الدمج أو يمنعه.'
    : 'MergePilot only comments and never approves or blocks merging.';

  const footer = `---\n${footerParts.length > 0 ? `${footerParts.join(' · ')}\n` : ''}${disclaimer}`;
  sections.push(footer);

  const content = sections.join('\n\n');

  if (isArabic) {
    return `<div dir="rtl">\n\n${content}\n\n</div>`;
  }

  return content;
}
