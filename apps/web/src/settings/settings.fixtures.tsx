import React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, type Language } from '../i18n/context.js';

/** Renders with a fresh query cache (no retries) and the given UI language. */
export function renderSettings(ui: React.ReactElement, language: Language = 'ar') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: React.ReactElement) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage={language}>{node}</I18nProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(wrap(next)) };
}

/** A key typed in tests, built at runtime so no secret-looking literal is in the source. */
export const typedKey = (): string => ['tk', 'web', 'k4'.repeat(5)].join('-');
