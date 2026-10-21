import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import { mergePanelFindings } from './consensus.js';
import { botFindingsFates } from './panel-findings-fate.js';
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
  it('uses neutral wording for summary-only findings presented by another bot in both languages', async () => {
    const panel = [1, 2].map((slot) => ({ slot, name: `Bot ${slot}`, inline: [], summaryOnly: [f({})] }));
    const merge = await mergePanelFindings({ bots: panel, minAgreement: 2 });
    const findingsFates = botFindingsFates(panel, { published: merge.kept, below: [], overLimit: [], alreadyPosted: [] });
    const input = { bots, merge, findingsFates, minAgreement: 2, inlineCount: 0 };
    expect(renderPanelSummary({ ...input, language: 'en' })).toContain("1 presented in another bot's wording");
    expect(renderPanelSummary({ ...input, language: 'ar' })).toContain('1 اتعرضت بصياغة بوت تاني');
  });

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

  it('lists the clusters over the findings limit in their own collapsible section (ADR-0033)', async () => {
    const merge = await mergePanelFindings({
      bots: [{ slot: 1, name: 'MergePilot', inline: [f({ title: 'Kept', severity: 'high' }), f({ title: 'Cut', path: 'b.ts' })], summaryOnly: [] }],
      minAgreement: 1,
      maxFindings: 1,
    });
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots, merge, minAgreement: 1, inlineCount: 1 });
    expect(body).toContain('<summary>Over the findings limit (1)</summary>');
    expect(body).toContain('**medium** · `b.ts:10` — Cut · _Found by: MergePilot (1/1)_');
    expect(renderPanelSummary({ language: 'ar', baseUrl: BASE, bots, merge, minAgreement: 1, inlineCount: 1 })).toContain(
      '<summary>فوق الحد الأقصى للملاحظات (1)</summary>',
    );
    const unlimited = renderPanelSummary({ language: 'en', baseUrl: BASE, bots, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(unlimited).not.toContain('Over the findings limit');
  });

  it('names each bot whose model output limit clamped its answer (ADR-0033)', async () => {
    const outputLimits = [{ maxFindings: 50, answerTokens: 6144, neededTokens: 16_024, bot: 'Owl' }];
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots, merge: await merged(), minAgreement: 2, inlineCount: 1, outputLimits });
    expect(body).toContain('allowed 6144 answer tokens instead of the 16024 sized for 50 findings');
    expect(body).toContain('may hold fewer findings. — **Owl**');
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

  it('says per bot why a fallback model answered, with the provider answer', async () => {
    const withFallback: PanelBotRow[] = [
      bots[0]!,
      { ...bots[1]!, modelLabel: 'zai-coding:glm-5.3', fallback: { from: 'opencode-zen:cat-jam-free', code: 'auth', detail: 'HTTP 401: not enabled' } },
    ];
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots: withFallback, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(body).toContain(
      '> ⚠️ Fallback model `zai-coding:glm-5.3` was used because `opencode-zen:cat-jam-free` failed (auth: HTTP 401: not enabled) — **Owl**',
    );
    expect(body.match(/Fallback model/g)).toHaveLength(1);
  });
});

describe('renderPanelSummary — review skills (ADR-0034)', () => {
  it('adds a Skill column only when a bot has a skill, with — for Default', async () => {
    const plain = renderPanelSummary({ language: 'en', bots, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(plain).not.toContain('Skill');

    const withSkill = bots.map((bot) => (bot.slot === 2 ? { ...bot, skill: 'Security' } : bot));
    const body = renderPanelSummary({ language: 'en', bots: withSkill, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(body).toContain('|  | Bot | Model | Skill | Status | Findings | Cost |');
    expect(body).toContain('| **Owl** | `openai:gpt-5` | Security | ✅ completed | 1 | $0.5000 |');
    expect(body).toContain('| **Fox** | `gemini:g-2` | — | ❌ failed | — | — |');

    const arabic = renderPanelSummary({ language: 'ar', bots: withSkill, merge: await merged(), minAgreement: 2, inlineCount: 1 });
    expect(arabic).toContain('| المراجع | النموذج | المهارة | الحالة |');
  });
});

describe('renderPanelSummary — withheld problems (ADR-0042)', () => {
  const withWithheld: PanelBotRow[] = [
    {
      ...bots[0]!,
      withheld: [
        { title: 'Null deref', reason: 'below the confidence bar' },
        { title: '@someone race', reason: 'out of scope' },
      ],
    },
  ];

  it('lists what a bot noticed and did not report under its summary, in the folded section', async () => {
    const body = renderPanelSummary({
      language: 'en', baseUrl: BASE, bots: withWithheld, merge: await merged(), minAgreement: 2, inlineCount: 1,
    });

    expect(body).toContain('_Noticed but not reported (2):_');
    expect(body).toContain('- Null deref — below the confidence bar');
    // Every model text is escaped as inline text: a mention never notifies anyone.
    expect(body).toContain('- @\u200bsomeone race — out of scope');
    expect(body).not.toMatch(/(^|\s)@someone/);
    // The list is inside the «Bot summaries» details, never an inline comment.
    const opened = body.indexOf('<summary>Bot summaries</summary>');
    const closed = body.indexOf('</details>', opened);
    const withheldAt = body.indexOf('_Noticed but not reported (2):_');
    expect(withheldAt).toBeGreaterThan(opened);
    expect(withheldAt).toBeLessThan(closed);
  });

  it('names the withheld list in Arabic', async () => {
    const body = renderPanelSummary({
      language: 'ar', baseUrl: BASE, bots: withWithheld, merge: await merged(), minAgreement: 2, inlineCount: 1,
    });

    expect(body).toContain('رصدها ولم ينشرها كملاحظات (2):');
    expect(body).toContain('- Null deref — below the confidence bar');
  });

  it('lists a bot whose summary is blank when it withheld problems', async () => {
    const blank: PanelBotRow[] = [{ ...withWithheld[0]!, summary: '   ' }];
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots: blank, merge: await merged(), minAgreement: 2, inlineCount: 1 });

    expect(body).toContain('<summary>Bot summaries</summary>');
    expect(body).toContain('**MergePilot**\n\n_Noticed but not reported (2):_');
  });

  it('renders a bot without withheld problems exactly as before', async () => {
    const body = renderPanelSummary({ language: 'en', baseUrl: BASE, bots, merge: await merged(), minAgreement: 2, inlineCount: 1 });

    expect(body).not.toContain('Noticed but not reported');
    expect(body).toContain('**MergePilot**\n\nMain summary');
  });

  it('escapes a withheld title, so it cannot close the folded section', async () => {
    const evil: PanelBotRow[] = [
      {
        ...bots[0]!,
        withheld: [{ title: '</details><h1>x</h1>', reason: 'out of scope' }],
      },
    ];
    const body = renderPanelSummary({
      language: 'en', baseUrl: BASE, bots: evil, merge: await merged(), minAgreement: 2, inlineCount: 1,
    });

    expect(body).not.toContain('</details><h1>');
    expect(body).toContain('&lt;/details&gt;');
  });
});
