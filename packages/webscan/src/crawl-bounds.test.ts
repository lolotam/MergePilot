import { describe, expect, it } from 'vitest';

import { ScanClient } from './client.js';
import { crawlSite } from './crawl.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput, ScanScope } from './types.js';

const BASE = 'https://example.com/';

function input(scope: ScanScope, overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    scope,
    limits: createLimits(),
    checks: {
      headers: true,
      cookies: true,
      transport: true,
      disclosure: true,
      files: true,
      active: true,
    },
    contact: 'ops@example.com',
    ...overrides,
  };
}

async function crawl(
  scope: ScanScope,
  pages: Record<string, string>,
  limits = createLimits(),
): Promise<{ requested: string[]; result: Awaited<ReturnType<typeof crawlSite>> }> {
  const transport = createFakeTransport((call) => {
    const body = pages[call.url];
    if (body === undefined) {
      return textResponse('', { status: 404 });
    }
    return textResponse(body);
  });
  const { deps } = createDependencies(transport);
  const client = new ScanClient(input(scope, { limits }), deps);
  const result = await crawlSite({
    client,
    scope,
    limits,
    identifyTarget: deps.identifyTarget,
  });
  return { requested: transport.calls.map((call) => call.url), result };
}

/** A page that carries many links. */
function pageWithLinks(prefix: string, count: number): string {
  return Array.from({ length: count }, (_unused, index) => `<a href="${prefix}/${index}">${index}</a>`).join('');
}

describe('the bounds of the plan of the crawler', () => {
  it('drops the links it cannot keep and reports it', async () => {
    const { requested, result } = await crawl(
      createScope(),
      { [BASE]: pageWithLinks('/docs', 40) },
      createLimits({ maxRequests: 5, maxPages: 10, maxResponseBytes: 16_384 }),
    );

    expect(result.linkCapReached).toBe(true);
    expect(requested.length).toBeLessThanOrEqual(5);
  });

  it('never spends more requests than the budget allows', async () => {
    const { requested, result } = await crawl(
      createScope(),
      { [BASE]: pageWithLinks('/docs', 40) },
      createLimits({ maxRequests: 4, maxPages: 10, maxResponseBytes: 16_384 }),
    );

    expect(requested.length).toBeLessThanOrEqual(4);
    expect(result.pages.length).toBeLessThanOrEqual(10);
  });

  it('keeps the links it is allowed to request when other links are refused', async () => {
    const denied = Array.from(
      { length: 40 },
      (_unused, index) => `<a href="/other/${index}">${index}</a>`,
    ).join('');
    const { requested, result } = await crawl(
      createScope(),
      { [BASE]: `${denied}<a href="/docs/a">a</a>` },
      createLimits({ maxRequests: 5, maxPages: 10, maxResponseBytes: 16_384 }),
    );

    // The refused links never enter the plan, so the link that may be
    // requested is still requested.
    expect(requested).toContain('https://example.com/docs/a');
    expect(requested.length).toBeLessThanOrEqual(5);
    // The crawler saw more links than it could keep, so it says so.
    expect(result.linkCapReached).toBe(true);
  });

  it('counts the links it saw without counting them twice', async () => {
    const { result } = await crawl(
      createScope(),
      {
        [BASE]: '<a href="/docs/a">a</a><a href="/docs/a">a again</a><a href="/docs/b">b</a>',
      },
    );

    expect(result.discovered).toBe(2);
  });

  it('never grows the ledger of what it saw without limit', async () => {
    const { result } = await crawl(
      createScope(),
      { [BASE]: pageWithLinks('/docs', 40) },
      createLimits({ maxRequests: 5, maxPages: 10, maxResponseBytes: 16_384 }),
    );

    expect(result.discovered).toBeLessThanOrEqual(5);
  });
});

describe('the bounds of the candidates of a crawl', () => {
  const scope = createScope({
    parameterizedPaths: [{ path: '/docs/a', parameters: ['id'] }],
  });

  it('keeps the authorized parameterized links it found', async () => {
    const { result } = await crawl(
      scope,
      {
        [BASE]: '<a href="/docs/a?id=1">one</a><a href="/docs/a?id=2">two</a><a href="/docs/b?id=3">three</a>',
      },
    );

    expect(result.candidates.map((candidate) => candidate.url)).toEqual([
      'https://example.com/docs/a?id=1',
      'https://example.com/docs/a?id=2',
    ]);
  });

  it('drops the candidates it cannot keep and reports it', async () => {
    const links = Array.from(
      { length: 10 },
      (_unused, index) => `<a href="/docs/a?id=${index}">${index}</a>`,
    ).join('');
    const { result } = await crawl(scope, { [BASE]: links }, createLimits({ maxActiveLinks: 3 }));

    expect(result.candidates).toHaveLength(3);
    expect(result.candidateCapReached).toBe(true);
  });

  it('carries the raw link of a candidate, because the check needs it', async () => {
    const { result } = await crawl(scope, { [BASE]: '<a href="/docs/a?id=secret">one</a>' });

    const candidate = result.candidates[0];
    expect(candidate?.url).toBe('https://example.com/docs/a?id=secret');
    expect(candidate?.path).toBe('/docs/a');
    expect(candidate?.parameterNames).toEqual(['id']);
  });
});
