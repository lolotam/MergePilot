import { afterEach, expect, it, vi } from 'vitest';
import { adminApi } from './admin.js';

afterEach(() => { vi.unstubAllGlobals(); });

it('sends all run filters as URL-encoded query parameters', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ runs: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const params = { user: 'a+b@example.test', repo: 'acme/50%_off', workspaceId: 'w',
    workspaceQuery: 'A & B', limit: 50, offset: 0 };
  await adminApi.getRuns(params);
  const [path, init] = fetchMock.mock.calls[0]!;
  const url = new URL(String(path), 'http://localhost');
  expect(url.pathname).toBe('/api/admin/runs');
  expect(Object.fromEntries(url.searchParams)).toEqual({ ...params, limit: '50', offset: '0' });
  expect(init?.credentials).toBe('include');
});
