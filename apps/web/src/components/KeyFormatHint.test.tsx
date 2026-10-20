import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n/context.js';
import { KeyFormatHint, keyFormatHint } from './KeyFormatHint.js';

/** Only the prefix matters here, so the rest is filler built at runtime: no secret-like literal in the source. */
const payAsYouGoKey = (): string => ['sk', 'api', 'k4'.repeat(4)].join('-');
const codingPlanKey = (): string => ['sk', 'cp', 'k4'.repeat(4)].join('-');

describe('keyFormatHint', () => {
  it('warns when a pay-as-you-go key is typed for the MiniMax Coding Plan', () => {
    expect(keyFormatHint('minimax-coding-plan', payAsYouGoKey())).toBe('minimaxCodingPlanKeyHint');
  });

  it('says nothing when the key matches the MiniMax Coding Plan', () => {
    expect(keyFormatHint('minimax-coding-plan', codingPlanKey())).toBeNull();
  });

  it('warns when a Coding Plan key is typed for the pay-as-you-go provider', () => {
    expect(keyFormatHint('minimax', codingPlanKey())).toBe('minimaxPayAsYouGoKeyHint');
  });

  it('says nothing when the key matches the pay-as-you-go provider', () => {
    expect(keyFormatHint('minimax', payAsYouGoKey())).toBeNull();
  });

  it('says nothing for the other providers', () => {
    expect(keyFormatHint('anthropic', payAsYouGoKey())).toBeNull();
    expect(keyFormatHint('anthropic', codingPlanKey())).toBeNull();
  });

  it('says nothing while the value is shorter than the minimum key length', () => {
    expect(keyFormatHint('minimax-coding-plan', 'sk-api')).toBeNull();
    expect(keyFormatHint('minimax', 'sk-cp')).toBeNull();
  });

  it('reads the format of the trimmed value', () => {
    expect(keyFormatHint('minimax-coding-plan', `  ${payAsYouGoKey()}  `)).toBe('minimaxCodingPlanKeyHint');
    expect(keyFormatHint('minimax', `\n${codingPlanKey()}\t`)).toBe('minimaxPayAsYouGoKeyHint');
  });
});

describe('KeyFormatHint', () => {
  const renderHint = (provider: string, value: string) =>
    render(
      <I18nProvider initialLanguage="en">
        <KeyFormatHint provider={provider} value={value} />
      </I18nProvider>,
    );

  it('shows the warning under the key input', () => {
    renderHint('minimax-coding-plan', payAsYouGoKey());
    expect(screen.getByRole('note').textContent).toContain('MiniMax Coding Plan');
  });

  it('renders nothing when the key matches the provider', () => {
    renderHint('minimax-coding-plan', codingPlanKey());
    expect(screen.queryByRole('note')).toBeNull();
  });
});
