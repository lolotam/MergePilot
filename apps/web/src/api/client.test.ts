import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchApi, ApiClientError, api } from './client.js';

describe('API client and fetchApi', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetchApi sends credentials include and returns json', async () => {
    const mockData = { test: true };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockData,
    } as unknown as Response);

    const result = await fetchApi<typeof mockData>('/api/test');
    expect(result).toEqual(mockData);

    expect(global.fetch).toHaveBeenCalledWith('/api/test', {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  });

  it('fetchApi returns undefined on 204 No Content', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    } as unknown as Response);

    const result = await fetchApi<void>('/api/test');
    expect(result).toBeUndefined();
  });

  it('fetchApi extracts ErrorBody on error status >= 400', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({
        error: {
          code: 'FORBIDDEN_ROLE',
          message: 'Insufficient workspace permissions',
        },
      }),
    } as unknown as Response);

    await expect(fetchApi('/api/workspaces/ws-1/keys')).rejects.toThrow(
      'Insufficient workspace permissions',
    );

    try {
      await fetchApi('/api/workspaces/ws-1/keys');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe('FORBIDDEN_ROLE');
      expect(apiErr.status).toBe(403);
      expect(apiErr.details).toEqual({});
    }
  });

  it('fetchApi keeps extra error fields as details', async () => {
    const workspaces = [{ id: 'ws-1', name: 'Acme Corp' }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        error: { code: 'sole_owner_of_shared_workspace', message: 'Refused', workspaces },
      }),
    } as unknown as Response);

    const err = await fetchApi('/api/admin/users/u-1', { method: 'DELETE' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('sole_owner_of_shared_workspace');
    expect((err as ApiClientError).details).toEqual({ workspaces });
  });

  it('api helper calls correct paths', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    await api.getMe();
    expect(global.fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'include' }));

    await api.getSettings('ws-abc');
    expect(global.fetch).toHaveBeenCalledWith('/api/workspaces/ws-abc/settings', expect.any(Object));

    await api.saveKey('ws-abc', 'openai', 'sk-fake-12345');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-abc/keys/openai',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ apiKey: 'sk-fake-12345' }),
      }),
    );
  });
});
