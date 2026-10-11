import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import { renderFindingComment } from './render.js';

const mockFinding: Finding = {
  id: 'finding-1',
  path: 'src/auth/token.ts',
  line: 42,
  side: 'RIGHT',
  title: 'Unchecked null pointer access',
  body: 'Variable user might be null when session expires.',
  severity: 'high',
  category: 'correctness',
  evidence: 'const name = user.name;',
  suggestion: 'const name = user?.name;',
  confidence: 0.95,
};

describe('renderFindingComment', () => {
  it('renders English labels when language is en', () => {
    const rendered = renderFindingComment(mockFinding, {
      language: 'en',
      suggestionsAsCode: true,
    });

    expect(rendered).toContain('Unchecked null pointer access');
    expect(rendered).toContain('Severity');
    expect(rendered).toContain('HIGH');
    expect(rendered).toContain('Variable user might be null when session expires.');
    expect(rendered).toContain('Evidence');
    expect(rendered).toContain('const name = user.name;');
    expect(rendered).toContain('Suggestion');
    expect(rendered).toContain('```suggestion');
    expect(rendered).toContain('const name = user?.name;');
  });

  it('renders Arabic labels when language is ar', () => {
    const rendered = renderFindingComment(mockFinding, {
      language: 'ar',
      suggestionsAsCode: true,
    });

    expect(rendered).toContain('Unchecked null pointer access');
    expect(rendered).toContain('الخطورة');
    expect(rendered).toContain('HIGH');
    expect(rendered).toContain('Variable user might be null when session expires.');
    expect(rendered).toContain('الدليل');
    expect(rendered).toContain('const name = user.name;');
    expect(rendered).toContain('الاقتراح');
    expect(rendered).toContain('```suggestion');
    expect(rendered).toContain('const name = user?.name;');
  });

  it('renders suggestion block only when suggestionsAsCode is true', () => {
    const asCode = renderFindingComment(mockFinding, {
      language: 'en',
      suggestionsAsCode: true,
    });
    expect(asCode).toContain('```suggestion\nconst name = user?.name;\n```');

    const asText = renderFindingComment(mockFinding, {
      language: 'en',
      suggestionsAsCode: false,
    });
    expect(asText).not.toContain('```suggestion');
    expect(asText).toContain('const name = user?.name;');
    expect(asText).toContain('Suggestion');
  });

  it('omits suggestion section when finding has no suggestion', () => {
    const findingNoSuggestion: Finding = {
      ...mockFinding,
      suggestion: undefined,
    };

    const renderedEn = renderFindingComment(findingNoSuggestion, {
      language: 'en',
      suggestionsAsCode: true,
    });
    expect(renderedEn).not.toContain('Suggestion');
    expect(renderedEn).not.toContain('```suggestion');

    const renderedAr = renderFindingComment(findingNoSuggestion, {
      language: 'ar',
      suggestionsAsCode: true,
    });
    expect(renderedAr).not.toContain('الاقتراح');
    expect(renderedAr).not.toContain('```suggestion');
  });

  it('puts evidence inside a fenced code block', () => {
    const rendered = renderFindingComment(mockFinding, {
      language: 'en',
      suggestionsAsCode: true,
    });

    expect(rendered).toMatch(/```[\r\n]+const name = user\.name;[\r\n]+```/);
  });

  it('lengthens the fence so evidence containing ``` cannot break out', () => {
    const rendered = renderFindingComment(
      { ...mockFinding, evidence: 'x\n```\n# injected heading' },
      { language: 'en', suggestionsAsCode: true },
    );

    expect(rendered).toContain('````\nx\n```\n# injected heading\n````');
  });
});
