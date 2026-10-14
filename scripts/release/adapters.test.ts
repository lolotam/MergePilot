import { describe, expect, it } from 'vitest';
import { githubAdapter } from './adapters.ts';

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
