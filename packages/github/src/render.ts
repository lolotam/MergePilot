import type { Finding } from '@mergepilot/engine';

export interface RenderFindingOptions {
  language: 'ar' | 'en';
  suggestionsAsCode: boolean;
}

interface Labels {
  severity: string;
  evidence: string;
  suggestion: string;
}

const LABELS_AR: Labels = {
  severity: 'الخطورة',
  evidence: 'الدليل',
  suggestion: 'الاقتراح',
};

const LABELS_EN: Labels = {
  severity: 'Severity',
  evidence: 'Evidence',
  suggestion: 'Suggestion',
};

/**
 * Wraps text in a code fence longer than any backtick run inside it, so model output
 * containing ``` cannot close the fence early and inject markdown.
 */
function fence(text: string, info = ''): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${ticks}${info}\n${text}\n${ticks}`;
}

/**
 * Renders an inline review finding comment with localized labels and GitHub markdown formatting.
 */
export function renderFindingComment(
  finding: Finding,
  { language, suggestionsAsCode }: RenderFindingOptions,
): string {
  const labels = language === 'ar' ? LABELS_AR : LABELS_EN;

  const sections: string[] = [
    `### ${finding.title}`,
    `**${labels.severity}:** \`${finding.severity.toUpperCase()}\``,
    finding.body,
    `**${labels.evidence}:**\n${fence(finding.evidence)}`,
  ];

  if (finding.suggestion) {
    if (suggestionsAsCode) {
      sections.push(`**${labels.suggestion}:**\n${fence(finding.suggestion, 'suggestion')}`);
    } else {
      sections.push(`**${labels.suggestion}:**\n${finding.suggestion}`);
    }
  }

  return sections.join('\n\n');
}
