import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider, type Language } from '../i18n/context.js';
import { RunCost } from './RunPriceSource.js';

function renderCost(props: Parameters<typeof RunCost>[0], language: Language = 'en') {
  return render(
    <I18nProvider initialLanguage={language}>
      <RunCost {...props} />
    </I18nProvider>,
  );
}

describe('run detail cost with its pricing source', () => {
  it('names the catalog that priced the run', () => {
    renderCost({
      costUsd: 0.0123,
      pricing: { source: 'catalog:openrouter', inputPerMTok: 3, outputPerMTok: 15, fetchedAt: '2026-10-13T02:30:00.000Z' },
    });
    expect(screen.getByTestId('run-cost').textContent).toBe('$0.0123 · OpenRouter price');
  });

  it('says the price is unknown when no source priced it', () => {
    renderCost({ costUsd: null, pricing: { source: 'unknown', inputPerMTok: null, outputPerMTok: null } });
    expect(screen.getByTestId('run-cost').textContent).toBe('— · price unknown');
  });

  it('labels manual and repo prices, in Arabic too', () => {
    const { unmount } = renderCost({ costUsd: 0.5, pricing: { source: 'repo', inputPerMTok: 1, outputPerMTok: 2 } });
    expect(screen.getByTestId('run-cost').textContent).toBe('$0.5000 · repo file price');
    unmount();
    renderCost({ costUsd: 0.5, pricing: { source: 'override', inputPerMTok: 1, outputPerMTok: 2 } }, 'ar');
    expect(screen.getByTestId('run-cost').textContent).toBe('$0.5000 · سعر يدوي');
  });

  it('shows only the cost for older runs without pricing', () => {
    renderCost({ costUsd: 0.01 });
    expect(screen.getByTestId('run-cost').textContent).toBe('$0.0100');
  });
});
