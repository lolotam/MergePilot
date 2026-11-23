import { expect, it } from 'vitest';
import { renderPanelSummary } from './panel-summary.js';
import { renderReviewSummary } from './summary.js';

const notShownArtifacts = [
  'api/`@team`<!--hidden/openapi.json',
  ...Array.from({ length: 11 }, (_, i) => `api/openapi.v${i + 2}.json`),
];

it.each([
  { language: 'en', label: 'Generated files changed but not reviewed (no diff could be built):', omitted: '+2 more' },
  { language: 'ar', label: 'ملفات مولَّدة تغيّرت ولم تُراجع (تعذّر بناء الفرق):', omitted: '+2 أخرى' },
] as const)('discloses up to ten paths without reporting an incomplete review ($language)', ({ language, label, omitted }) => {
  const review = renderReviewSummary({
    language, summary: '', summaryOnly: [], inlineCount: 0, complete: true, incompleteReasons: [],
    modelLabel: 'review-model', outcome: 'completed', notShownArtifacts,
  });
  const panel = renderPanelSummary({
    language, bots: [], merge: { kept: [], below: [], overLimit: [], total: 0 },
    minAgreement: 1, inlineCount: 0, notShownArtifacts,
  });
  for (const summary of [review, panel]) {
    const note = summary.split('\n').find((line) => line.includes(label));
    expect(note).toContain('api/`@team`&lt;!--hidden/openapi.json');
    expect(note).toContain('`api/openapi.v10.json`');
    expect(note).not.toContain('api/openapi.v11.json');
    expect(note).toContain(omitted);
    expect(summary).not.toMatch(/Incomplete review|مراجعة غير مكتملة/);
  }
});
