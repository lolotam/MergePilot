import { describe, expect, it } from 'vitest';

import { ScanClient } from './client.js';
import { crawlSite } from './crawl.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  targetKeyOf,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput, ScanScope } from './types.js';

const BASE = 'https://example.com/';

function input(scope: ScanScope, limits = createLimits()): ScanInput {
  return {
    scope,
    limits,
    checks: {
      headers: true,
      cookies: true,
      transport: true,
      disclosure: true,
      files: true,
      active: true,
    },
    contact: 'ops@example.com',
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
  const client = new ScanClient(input(scope, limits), deps);
  const result = await crawlSite({
    client,
    scope,
    limits,
    identifyTarget: deps.identifyTarget,
  });
  return { requested: transport.calls.map((call) => call.url), result };
}

describe('the links of a page', () => {
  it('follows the links of the site it is authorized to crawl', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="/docs/a">a</a><a href="/docs/b">b</a>',
      'https://example.com/docs/a': 'ok',
      'https://example.com/docs/b': 'ok',
    });

    expect(requested).toEqual([
      BASE,
      'https://example.com/docs/a',
      'https://example.com/docs/b',
    ]);
  });

  it('reads a malformed document without losing the links it does have', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<html><body><p>unclosed<a href="/docs/a">a</div>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).toContain('https://example.com/docs/a');
  });

  it('requests a link once, even when the page repeats it', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="/docs/a">1</a><a href="/docs/a">2</a><a href="/docs/a#top">3</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested.filter((url) => url === 'https://example.com/docs/a')).toHaveLength(1);
  });

  it('drops the fragment of a link', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="/docs/a#section">a</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).toContain('https://example.com/docs/a');
  });

  it('keeps the query of an authorized parameterized link and drops its fragment', async () => {
    const scope = createScope({
      parameterizedPaths: [{ path: '/docs/a', parameters: ['page'] }],
    });
    const { requested } = await crawl(scope, {
      [BASE]: '<a href="/docs/a?page=2#section">a</a>',
      'https://example.com/docs/a?page=2': 'ok',
    });

    expect(requested).toContain('https://example.com/docs/a?page=2');
  });

  it('never submits a form and never runs a script', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]:
        '<form action="/docs/post" method="post"><input name="a"></form>' +
        '<script src="/docs/script.js"></script>' +
        '<a href="/docs/a">a</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).not.toContain('https://example.com/docs/post');
    expect(requested).not.toContain('https://example.com/docs/script.js');
  });

  it('skips a link with a scheme that is not http', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="mailto:ops@example.com">mail</a><a href="javascript:alert(1)">x</a>',
    });

    expect(requested).toEqual([BASE]);
  });
});

describe('the scope of a discovered link', () => {
  it('skips a link outside the crawl rules', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="/admin">admin</a><a href="/docs/a">a</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).not.toContain('https://example.com/admin');
    expect(requested).toContain('https://example.com/docs/a');
  });

  it('skips a blocked path even when an allow rule matches it', async () => {
    const scope = createScope({
      crawlPaths: [{ path: '/', kind: 'prefix' }],
      blockedPaths: [{ path: '/checkout', kind: 'prefix' }],
    });
    const { requested } = await crawl(scope, {
      [BASE]: '<a href="/checkout/cart">cart</a><a href="/docs/a">a</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).not.toContain('https://example.com/checkout/cart');
  });

  it('skips a denied action', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="/docs/logout">out</a><a href="/docs/a">a</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).not.toContain('https://example.com/docs/logout');
  });

  it('skips a link on another host', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="https://other.example.com/docs/a">a</a><a href="/docs/a">b</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(requested).not.toContain('https://other.example.com/docs/a');
  });

  it('skips a parameterized link that was not authorized', async () => {
    const { requested } = await crawl(createScope(), {
      [BASE]: '<a href="/docs/a?id=7">a</a><a href="/docs/b">b</a>',
      'https://example.com/docs/b': 'ok',
    });

    expect(requested).not.toContain('https://example.com/docs/a?id=7');
  });

  it('follows a parameterized link whose names are authorized', async () => {
    const scope = createScope({
      parameterizedPaths: [{ path: '/docs/a', parameters: ['id'] }],
    });
    const { requested } = await crawl(scope, {
      [BASE]: '<a href="/docs/a?id=7">a</a>',
      'https://example.com/docs/a?id=7': 'ok',
    });

    expect(requested).toContain('https://example.com/docs/a?id=7');
  });

  it('skips a parameterized link that carries a name the rule does not name', async () => {
    const scope = createScope({
      parameterizedPaths: [{ path: '/docs/a', parameters: ['id'] }],
    });
    const { requested } = await crawl(scope, {
      [BASE]: '<a href="/docs/a?id=7&token=x">a</a>',
    });

    expect(requested).not.toContain('https://example.com/docs/a?id=7&token=x');
  });

  it('discovers no link at all when the crawl rules are empty', async () => {
    const scope = createScope({ crawlPaths: [] });
    const { requested, result } = await crawl(scope, {
      [BASE]: '<a href="/docs/a">a</a><a href="/docs/b">b</a>',
    });

    expect(requested).toEqual([BASE]);
    expect(result.pages).toHaveLength(1);
    expect(result.discovered).toBe(2);
  });
});

describe('the bounds of the crawl', () => {
  it('stops at the page cap and reports it', async () => {
    const { requested, result } = await crawl(
      createScope(),
      {
        [BASE]: '<a href="/docs/a">a</a><a href="/docs/b">b</a><a href="/docs/c">c</a>',
        'https://example.com/docs/a': 'ok',
        'https://example.com/docs/b': 'ok',
        'https://example.com/docs/c': 'ok',
      },
      createLimits({ maxPages: 2 }),
    );

    expect(requested).toHaveLength(2);
    expect(result.pageCapReached).toBe(true);
  });

  it('records the identity of every page it read', async () => {
    const { result } = await crawl(createScope(), {
      [BASE]: '<a href="/docs/a">a</a>',
      'https://example.com/docs/a': 'ok',
    });

    expect(result.pages.map((page) => page.targetKey)).toEqual([
      targetKeyOf('https://example.com/'),
      targetKeyOf('https://example.com/docs/a'),
    ]);
  });

  it('resolves a relative link against the base element of the page', async () => {
    const scope = createScope({
      crawlPaths: [{ path: '/other', kind: 'prefix' }],
    });
    const { requested } = await crawl(scope, {
      [BASE]: '<head><base href="https://example.com/other/"></head><body><a href="a">a</a></body>',
      'https://example.com/other/a': 'ok',
    });

    expect(requested).toContain('https://example.com/other/a');
  });
});

describe('a page the scan cannot read', () => {
  it('keeps the failure with the target and carries on', async () => {
    const transport = createFakeTransport((call) => {
      if (call.url === BASE) {
        return new Error('connection reset');
      }
      return textResponse('<a href="/docs/a">a</a>', { status: 200 });
    });
    const { deps } = createDependencies(transport);
    const scope = createScope();
    const client = new ScanClient(input(scope), deps);

    const result = await crawlSite({ client, scope, limits: createLimits(), identifyTarget: deps.identifyTarget });

    expect(result.baseTargetFailed).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.targetKey).toBe(targetKeyOf('https://example.com/'));
  });
});
