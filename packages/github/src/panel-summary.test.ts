import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import { mergePanelFindings } from './consensus.js';
import { renderPanelSummary, type PanelBotRow } from './panel-summary.js';

const BASE = 'https://mp.example.com';
const f = (over: Partial<Finding>): Finding => ({
  id: over.title ?? 'f',
  path: 'src/a.ts',
  line: 10,
  side: 'RIGHT',
  title: 'Issue',
  body: 'Body.',
  severity: 'medium',
  category: 'correctness',
  evidence: 'e',
  confidence: 0.9,
  ...over,
});

const bots: PanelBotRow[] = [
  { slot: 1, name: 'MergePilot', logo: 'pilot', modelLabel: 'anthropic:claude-x', status: 'completed', findings: 2, costUsd: 0.0123, summary: 'Main summary' },
  { slot: 2, name: 'Owl', logo: 'owl', modelLabel: 'openai:gpt-5', status: 'completed', findings: 1, costUsd: 0.5 },
  { slot: 3, name: 'Fox', logo: 'fox', modelLabel: 'gemini:g-2', status: 'failed', findings: null, costUsd: null },
];

async function merged() {
  return mergePanelFindings({
    bots: [
      { slot: 1, name: 'MergePilot', inline: [f({ title: 'Agreed' }), f({ title: 'Lonely', path: 'b.ts' })], summaryOnly: [] },
      { slot: 2, name: 'Owl', inline: [f({ title: 'Agreed' })], summaryOnly: [f({ title: 'Outside', path: 'c.ts' })] },
    ],
    minAgreement: 2,
  });
}

describe('renderPanelSummary (consensus, ADR-0017)', () => {
  it('has the panel header and one table row per bot with logo, name, model, status, findings and cost', async () => {
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(body.startsWith('## Review panel')).toBe(true);
    expect(body).toContain('|  | Bot | Model | Status | Findings | Cost |');
    expect(body).toContain(
      `| <img src="${BASE}/bots/pilot.svg" width="20" height="20" alt=""> | **MergePilot** | \`anthropic:claude-x\` | ✅ completed | 2 | $0.0123 |`,
    );
    expect(body).toContain('| **Fox** | `gemini:g-2` | ❌ failed | — | — |');
    expect(body).toContain('at least 2 of 2 bots');
  });

  it('lists what fell below the agreement in a collapsible section, with who found it', async () => {
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(body).toContain('<summary>Below agreement (2)</summary>');
    expect(body).toContain('**medium** · `b.ts:10` — Lonely · _Found by: MergePilot (1/2)_');
    expect(body).toContain('`c.ts:10` — Outside · _Found by: Owl (1/2)_');
    expect(body).toContain('<summary>Bot summaries</summary>');
    expect(body).toContain('Inline comments: 1 · Outside diff: 0');
  });

  it('renders in Arabic inside an RTL block', async () => {
    const body = renderPanelSummary({ language: 'ar', baseUrl: BASE, bots, merge: await merged(), minAgreement: 1, inlineCount: 1 });
    expect(body.startsWith('<div dir="rtl">\n\n## لوحة المراجعين')).toBe(true);
    expect(body).toContain('❌ فشلت');
    expect(body).not.toContain('المعروض:');
  });

  it('neutralizes bot names and model text', async () => {
    const evil: PanelBotRow[] = [{ slot: 2, name: 'x | <!-- y -->', logo: 'owl', modelLabel: 'a:b|c', status: 'completed' }];
    const body = renderPanelSummary({ language: 'en', bots: evil, merge: await merged(), minAgreement: 1, inlineCount: 0 });
    expect(body).not.toContain('<!--');
    expect(body).toContain('\\|');
    expect(body).toContain('`a:b c`');
  });
});
