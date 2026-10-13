import { describe, expect, it } from 'vitest';
import { renderBotIdentity, renderBotLogo } from './bot-identity.js';
import { renderReviewSummary } from './summary.js';

const BASE = 'https://mergepilot.example.com';

describe('bot identity header (ADR-0017)', () => {
  it('shows the logo, the bold name and the model label', () => {
    expect(renderBotIdentity({ name: 'Owl', logo: 'owl', modelLabel: 'openai:gpt-5', baseUrl: `${BASE}/` })).toBe(
      `<img src="${BASE}/bots/owl.svg" width="20" height="20" alt=""> **Owl** · \`openai:gpt-5\``,
    );
  });

  it('escapes the name so it cannot inject HTML, a hidden marker or a mention', () => {
    const line = renderBotIdentity({ name: '<!-- x --> *@team* [a](b)', logo: 'fox', modelLabel: 'a:b', baseUrl: BASE });
    expect(line).not.toContain('<!--');
    expect(line).toContain('&lt;!-- x --&gt;');
    expect(line).toContain('@​team');
    expect(line).toContain('\\[a\\]');
  });

  it('leaves the logo out without a usable base URL and falls back to pilot for an odd key', () => {
    expect(renderBotLogo(undefined, 'owl')).toBe('');
    expect(renderBotLogo('javascript:alert(1)', 'owl')).toBe('');
    expect(renderBotLogo(BASE, '../x"')).toBe(`<img src="${BASE}/bots/pilot.svg" width="20" height="20" alt="">`);
    expect(renderBotIdentity({ name: 'B', logo: 'owl', modelLabel: 'a:b' })).toBe('**B** · `a:b`');
  });

  it('the review summary starts with the identity line; without one it is unchanged', () => {
    const input = {
      language: 'en' as const,
      summary: 'ok',
      summaryOnly: [],
      inlineCount: 0,
      complete: true,
      incompleteReasons: [],
      modelLabel: 'openai:gpt-5',
      outcome: 'completed' as const,
    };
    const plain = renderReviewSummary(input);
    const withBot = renderReviewSummary({ ...input, identity: { name: 'Owl', logo: 'owl', modelLabel: 'openai:gpt-5', baseUrl: BASE } });
    expect(plain.startsWith('## MergePilot review')).toBe(true);
    expect(withBot.startsWith(`<img src="${BASE}/bots/owl.svg"`)).toBe(true);
    expect(withBot).toBe(`${renderBotIdentity({ name: 'Owl', logo: 'owl', modelLabel: 'openai:gpt-5', baseUrl: BASE })}\n\n${plain}`);
  });
});
