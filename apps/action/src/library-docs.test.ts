import { describe, expect, it, vi } from 'vitest';
import { fetchLibraryDocs } from './library-docs.js';

describe('fetchLibraryDocs', () => {
  it('returns an empty array when source is "none"', async () => {
    const fetchMock = vi.fn();
    const docs = await fetchLibraryDocs({
      libraries: [{ name: 'lodash', version: '4.17.21' }],
      source: 'none',
      maxCharsPerLibrary: 5000,
      maxLibraries: 5,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(docs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty array when libraries list is empty', async () => {
    const fetchMock = vi.fn();
    const docs = await fetchLibraryDocs({
      libraries: [],
      source: 'npm',
      maxCharsPerLibrary: 5000,
      maxLibraries: 5,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(docs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits fetched libraries to maxLibraries', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const name = url.split('/').pop() ?? '';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            name,
            readme: `# README for ${name}`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    const docs = await fetchLibraryDocs({
      libraries: [
        { name: 'lib-a', version: '1.0.0' },
        { name: 'lib-b', version: '2.0.0' },
        { name: 'lib-c', version: '3.0.0' },
      ],
      source: 'npm',
      maxCharsPerLibrary: 5000,
      maxLibraries: 2,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.name)).toEqual(['lib-a', 'lib-b']);
  });

  describe('npm source', () => {
    it('uses versions[version].readme when exact version readme is present', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: 'lodash',
            readme: 'Top-level README',
            versions: {
              '4.17.21': {
                name: 'lodash',
                version: '4.17.21',
                readme: 'Exact 4.17.21 README content',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const docs = await fetchLibraryDocs({
        libraries: [{ name: 'lodash', version: '4.17.21' }],
        source: 'npm',
        maxCharsPerLibrary: 5000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(docs).toHaveLength(1);
      const doc = docs[0]!;
      expect(doc.name).toBe('lodash');
      expect(doc.version).toBe('4.17.21');
      expect(doc.source).toBe('npm');
      expect(doc.content).toContain('Source: npm README for lodash@4.17.21');
      expect(doc.content).toContain('Exact 4.17.21 README content');
      expect(doc.content.startsWith('Source: npm README for lodash@4.17.21')).toBe(true);
    });

    it('falls back to top-level readme when exact version has none', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: 'lodash',
            readme: 'Top-level README fallback content',
            versions: {
              '4.17.21': {
                name: 'lodash',
                version: '4.17.21',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const docs = await fetchLibraryDocs({
        libraries: [{ name: 'lodash', version: '4.17.21' }],
        source: 'npm',
        maxCharsPerLibrary: 5000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(docs).toHaveLength(1);
      const doc = docs[0]!;
      expect(doc.name).toBe('lodash');
      expect(doc.version).toBe('4.17.21');
      expect(doc.source).toBe('npm');
      expect(doc.content).toContain(
        'Source: npm README for lodash@4.17.21 (latest README; exact version had none)',
      );
      expect(doc.content).toContain('Top-level README fallback content');
    });

    it('truncates content to maxCharsPerLibrary', async () => {
      const longReadme = 'A'.repeat(2000);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: 'big-lib',
            readme: longReadme,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const docs = await fetchLibraryDocs({
        libraries: [{ name: 'big-lib', version: '1.0.0' }],
        source: 'npm',
        maxCharsPerLibrary: 500,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(docs).toHaveLength(1);
      expect(docs[0]!.content.length).toBe(500);
    });

    it('skips library on non-2xx or failure without throwing', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('failing-pkg')) {
          return Promise.resolve(new Response('Not found', { status: 404 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: 'good-pkg',
              readme: 'Good content',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      });

      const docs = await fetchLibraryDocs({
        libraries: [
          { name: 'failing-pkg', version: '1.0.0' },
          { name: 'good-pkg', version: '2.0.0' },
        ],
        source: 'npm',
        maxCharsPerLibrary: 5000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(docs).toHaveLength(1);
      expect(docs[0]!.name).toBe('good-pkg');
    });

    it('handles scoped packages properly', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: '@scope/pkg',
            readme: 'Scoped readme',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const docs = await fetchLibraryDocs({
        libraries: [{ name: '@scope/pkg', version: '1.0.0' }],
        source: 'npm',
        maxCharsPerLibrary: 5000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(docs).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/https:\/\/registry\.npmjs\.org\/(@scope%2Fpkg|%40scope%2Fpkg)/),
        expect.anything(),
      );
    });
  });

  describe('context7 source', () => {
    it('fetches docs from context7 on happy path', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/search?query=')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [{ id: 'zod-doc-id-123' }],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        if (url.includes('/api/v1/zod-doc-id-123')) {
          return Promise.resolve(
            new Response('Context7 Zod documentation text', {
              status: 200,
              headers: { 'Content-Type': 'text/plain' },
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected URL ${url}`));
      });

      const docs = await fetchLibraryDocs({
        libraries: [{ name: 'zod', version: '3.22.4' }],
        source: 'context7',
        maxCharsPerLibrary: 4000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
        env: { CONTEXT7_API_KEY: 'sk-test-000' },
      });

      expect(docs).toHaveLength(1);
      const doc = docs[0]!;
      expect(doc.name).toBe('zod');
      expect(doc.version).toBe('3.22.4');
      expect(doc.source).toBe('context7');
      expect(doc.content).toContain('Context7 Zod documentation text');

      // Check auth header and tokens param
      expect(fetchMock).toHaveBeenCalledWith(
        'https://context7.com/api/v1/search?query=zod',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-000',
          }),
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/zod-doc-id-123?type=txt&tokens=1000'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-000',
          }),
        }),
      );
    });

    it('falls back to npm when CONTEXT7_API_KEY is missing, logging a warning', async () => {
      const logMock = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: 'lodash',
            readme: 'Lodash npm readme',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const docs = await fetchLibraryDocs({
        libraries: [{ name: 'lodash', version: '4.17.21' }],
        source: 'context7',
        maxCharsPerLibrary: 5000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
        env: {},
        log: logMock,
      });

      expect(logMock).toHaveBeenCalledWith(expect.stringContaining('CONTEXT7_API_KEY'));
      expect(docs).toHaveLength(1);
      const doc = docs[0]!;
      expect(doc.source).toBe('npm');
      expect(doc.content).toContain('Lodash npm readme');
    });

    it('falls back to npm when context7 search or fetch fails (non-2xx or bad shape)', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('context7.com')) {
          return Promise.resolve(new Response('Error', { status: 500 }));
        }
        if (url.includes('registry.npmjs.org')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                name: 'react',
                readme: 'React npm readme',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected URL ${url}`));
      });

      const docs = await fetchLibraryDocs({
        libraries: [{ name: 'react', version: '18.2.0' }],
        source: 'context7',
        maxCharsPerLibrary: 5000,
        maxLibraries: 5,
        fetch: fetchMock as unknown as typeof fetch,
        env: { CONTEXT7_API_KEY: 'sk-test-000' },
      });

      expect(docs).toHaveLength(1);
      const doc = docs[0]!;
      expect(doc.source).toBe('npm');
      expect(doc.content).toContain('React npm readme');
      expect(doc.content).toContain('context7 fallback');
    });
  });

  it('guarantees that outgoing requests contain ONLY library name and version (no repo name, no code)', async () => {
    const fetchedUrls: string[] = [];
    const fetchedHeaders: Record<string, string>[] = [];

    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      fetchedUrls.push(url);
      if (init?.headers) {
        fetchedHeaders.push(init.headers as Record<string, string>);
      }
      if (url.includes('context7.com/api/v1/search')) {
        return Promise.resolve(
          new Response(JSON.stringify({ results: [{ id: 'mock-id' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response('Mock documentation text', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    });

    const repoName = 'secret-org/private-repo';
    const secretCode = 'function superSecretCode() { return 42; }';

    await fetchLibraryDocs({
      libraries: [{ name: 'safe-lib', version: '1.2.3' }],
      source: 'context7',
      maxCharsPerLibrary: 4000,
      maxLibraries: 5,
      fetch: fetchMock as unknown as typeof fetch,
      env: { CONTEXT7_API_KEY: 'sk-test-000' },
    });

    for (const url of fetchedUrls) {
      expect(url).not.toContain(repoName);
      expect(url).not.toContain(secretCode);
      const parsed = new URL(url);
      // Host must only be context7.com or registry.npmjs.org
      expect(['context7.com', 'registry.npmjs.org']).toContain(parsed.host);
    }

    for (const headers of fetchedHeaders) {
      const headerStr = JSON.stringify(headers);
      expect(headerStr).not.toContain(repoName);
      expect(headerStr).not.toContain(secretCode);
    }
  });

  it('keeps @ literal for scoped packages and slashes in Context7 ids', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/search')) {
        return new Response(JSON.stringify([{ id: '/vercel/next.js' }]), { status: 200 });
      }
      if (url.includes('context7.com/api/v1/vercel/next.js')) {
        return new Response('next docs', { status: 200 });
      }
      return new Response(JSON.stringify({ readme: 'scoped readme' }), { status: 200 });
    }) as typeof fetch;

    await fetchLibraryDocs({
      libraries: [{ name: '@scope/pkg', version: '1.0.0' }],
      source: 'npm',
      maxCharsPerLibrary: 1000,
      maxLibraries: 5,
      fetch: fakeFetch,
    });
    const ctx = await fetchLibraryDocs({
      libraries: [{ name: 'next', version: '15.0.0' }],
      source: 'context7',
      maxCharsPerLibrary: 1000,
      maxLibraries: 5,
      fetch: fakeFetch,
      env: { CONTEXT7_API_KEY: 'test-key' },
    });

    expect(urls).toContain('https://registry.npmjs.org/@scope%2Fpkg');
    expect(urls.some((u) => u.startsWith('https://context7.com/api/v1/vercel/next.js?'))).toBe(true);
    expect(ctx[0]?.source).toBe('context7');
  });
});
