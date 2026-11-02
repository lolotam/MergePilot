import { afterEach, describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWebScanSiteOptionsQuery } from './hooks.js';
import { installFetch, jsonResponse, siteFixture } from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** A list of `count` sites, answered page by page like the real API. */
function answerWithSites(count: number) {
  const all = Array.from({ length: count }, (_, index) => ({
    ...siteFixture,
    id: `site-${index + 1}`,
    hostname: `site-${index + 1}.example.com`,
  }));
  return installFetch((call) => {
    const query = new URL(call.url, 'http://localhost').searchParams;
    const offset = Number(query.get('offset') ?? '0');
    const limit = Number(query.get('limit') ?? '0');
    return jsonResponse({ sites: all.slice(offset, offset + limit), total: all.length, limit, offset });
  });
}

function renderOptions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useWebScanSiteOptionsQuery(), { wrapper });
}

describe('the site options of the scan panels', () => {
  it('never returns a partial list, however many sites the server reports', async () => {
    // More sites than twenty pages of one hundred: no page cap may cut the list short.
    const calls = answerWithSites(2150);
    const { result } = renderOptions();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.sites).toHaveLength(2150);
    expect(result.current.data?.total).toBe(2150);
    expect(result.current.data?.sites[2149]?.id).toBe('site-2150');
    expect(calls).toHaveLength(22);
  });

  it('asks once when every site fits in one page', async () => {
    const calls = answerWithSites(3);
    const { result } = renderOptions();

    await waitFor(() => expect(result.current.data?.sites).toHaveLength(3));
    expect(calls).toHaveLength(1);
  });
});
