import { describe, expect, it } from 'vitest';
import { githubAdapter, withDeadline } from './adapters.ts';

const SHA = 'a'.repeat(40);

/** Fake GitHub commit endpoint that serves `total` changed files, 300 per page. */
function commitFetch(total: number) {
  const pages: number[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    const from = (page - 1) * 300;
    const files = Array.from({ length: Math.max(0, Math.min(300, total - from)) }, (_, i) => ({ filename: `docs/f${from + i}.md` }));
    return new Response(JSON.stringify({ commit: { message: 'm' }, files }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, pages };
}

describe('githubAdapter.commitFiles', () => {
  it('reads every page of a large commit so no image-building file is cut off', async () => {
    const { fetchImpl, pages } = commitFetch(650);
    const files = await githubAdapter({ repository: 'o/r', token: 't', fetchImpl }).commitFiles(SHA);
    expect(files).toHaveLength(650);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('refuses a commit larger than the API can list instead of guessing', async () => {
    const { fetchImpl } = commitFetch(3000);
    await expect(githubAdapter({ repository: 'o/r', token: 't', fetchImpl }).commitFiles(SHA)).rejects.toThrow(/more files than the API lists/);
  });
});

describe('githubAdapter.writeReleaseCommit', () => {
  it('moves the release branch as a fast-forward of the expected head, never a forced update', async () => {
    const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/repos/o/r', '');
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push({ method, path, body: JSON.parse(String(init?.body)) });
      const body =
        path.startsWith('/git/commits/') ? { tree: { sha: 't0' } }
        : path === '/git/trees' ? { sha: 't1' }
        : path === '/git/commits' ? { sha: 'c1' }
        : path === '/branches/production' ? { commit: { sha: 'h0', commit: { message: 'm' } } }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const sha = await githubAdapter({ repository: 'o/r', token: 't', fetchImpl })
      .writeReleaseCommit({ branch: 'production', parentSha: SHA, path: 'deploy/c.yml', content: 'x', message: 'm', expectedHead: 'h0' });
    expect(sha).toBe('c1');
    expect(sent.find((s) => s.path === '/git/commits')?.body.parents).toEqual([SHA, 'h0']);
    expect(sent.find((s) => s.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/git/refs/heads/production', body: { sha: 'c1', force: false } });
  });
});

describe('withDeadline', () => {
  it('aborts a request that stalls past its deadline', async () => {
    const stalled = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    await expect(withDeadline(stalled, 20)('https://example.test')).rejects.toThrow(/timeout|aborted/i);
  });

  it('keeps a signal the caller passed', async () => {
    const stalled = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    const caller = new AbortController();
    const request = withDeadline(stalled, 60_000)('https://example.test', { signal: caller.signal });
    caller.abort(new Error('caller stopped'));
    await expect(request).rejects.toThrow('caller stopped');
  });
});
