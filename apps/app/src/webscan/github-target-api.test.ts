import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubTargetApiError } from './github-target.js';
import { createGitHubTargetApi } from './github-target-api.js';

/**
 * The tests of the production GitHub boundary of the alert target.
 *
 * The transport is a fake, so no test ever reaches GitHub. The private key of
 * the App is generated at run time, so no key material ever reaches the source.
 */

/** A token-shaped value that is built at run time and must never leak. */
const HOSTILE_TOKEN = ['gh', 'p', '_', 'hostile', 'token', 'value'].join('');

/** A private key of the App, generated at run time. */
function aPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const PRIVATE_KEY = aPrivateKey();

/** One reply of the fake transport. */
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Builds a fake transport that answers by the path of the url. */
function fakeFetch(replies: Record<string, Reply | (() => never)>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace('https://api.github.com', '');
    const key = Object.keys(replies).find((candidate) => path.startsWith(candidate));
    if (key === undefined) {
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const reply = replies[key];
    if (typeof reply === 'function') reply();
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
}

/** The api under test, with the fake transport. */
function apiWith(replies: Record<string, Reply | (() => never)>) {
  const fetchFn = fakeFetch(replies);
  return {
    fetchFn,
    api: createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
}

describe('the production GitHub boundary of the alert target', () => {
  it('lists the installations of the user with the account id GitHub reports', async () => {
    const { api, fetchFn } = apiWith({
      '/user/installations': {
        status: 200,
        body: {
          total_count: 1,
          installations: [
            { id: 101, account: { id: 401, login: 'acme', type: 'Organization' } },
          ],
        },
      },
    });

    const installations = await api.listUserInstallations(HOSTILE_TOKEN);
    expect(installations).toEqual([
      {
        id: 101,
        accountLogin: 'acme',
        accountId: 401,
        accountType: 'Organization',
        repositorySelection: 'selected',
        suspended: false,
      },
    ]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('/user/installations');
  });

  it('reads the record of the installation with the App itself', async () => {
    const { api, fetchFn } = apiWith({
      '/app/installations/101': {
        status: 200,
        body: {
          id: 101,
          account: { id: 401, login: 'acme' },
          suspended_at: null,
          permissions: { issues: 'write' },
        },
      },
    });

    const installation = await api.getInstallation(101);
    expect(installation).toEqual({
      id: 101,
      accountId: 401,
      accountLogin: 'acme',
      suspended: false,
      issuesWrite: true,
    });

    // The App jwt is the credential of the call, and it never leaves the header.
    const init = fetchFn.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(init.headers.Authorization).not.toContain(HOSTILE_TOKEN);
  });

  it('reads a repository with the token of the installation', async () => {
    const { api, fetchFn } = apiWith({
      '/app/installations/101/access_tokens': { status: 201, body: { token: 'installation-token' } },
      '/repos/acme/demo': {
        status: 200,
        body: { id: 7, name: 'demo', private: true, visibility: 'private', owner: { id: 401, login: 'acme' } },
      },
    });

    const repository = await api.getRepository(101, 'acme', 'demo');
    expect(repository).toEqual({
      id: 7,
      owner: 'acme',
      name: 'demo',
      private: true,
      ownerAccountId: 401,
      visibility: 'private',
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('/access_tokens');
  });

  it('follows the pages of the repositories of an installation', async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [{ id: 7, name: 'demo', owner: { id: 401, login: 'acme' } }],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              Link: '<https://api.github.com/user/installations/101/repositories?page=2>; rel="next"',
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          total_count: 2,
          repositories: [{ id: 8, name: 'other', owner: { id: 401, login: 'acme' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const api = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const repositories = await api.listInstallationRepositories(HOSTILE_TOKEN, 101);
    expect(repositories.map((repository) => repository.id)).toEqual([7, 8]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('tells the class of a failure apart and never leaks the token', async () => {
    const cases: Array<[number, string]> = [
      [404, 'not_found'],
      [403, 'forbidden'],
      [500, 'server_error'],
    ];
    for (const [status, expected] of cases) {
      const { api } = apiWith({ '/app/installations/101': { status } });
      let caught: unknown = null;
      try {
        await api.getInstallation(101);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubTargetApiError);
      expect((caught as GitHubTargetApiError).status).toBe(expected);
      expect(String(caught)).not.toContain(HOSTILE_TOKEN);
    }
  });

  it('tells a timeout and a network error apart', async () => {
    const timeout = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: (async () => {
        const error = new Error('the request timed out');
        error.name = 'TimeoutError';
        throw error;
      }) as unknown as typeof fetch,
    });
    let caught: unknown = null;
    try {
      await timeout.getInstallation(101);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as GitHubTargetApiError).status).toBe('timeout');

    const offline = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: (async () => {
        throw new Error(`the network is down: ${HOSTILE_TOKEN}`);
      }) as unknown as typeof fetch,
    });
    caught = null;
    try {
      await offline.getInstallation(101);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as GitHubTargetApiError).status).toBe('network');
    expect(String(caught)).not.toContain(HOSTILE_TOKEN);
  });

  it('refuses a private key it cannot sign with', async () => {
    const api = createGitHubTargetApi({
      appId: '12345',
      privateKey: 'not-a-key',
      fetchFn: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    let caught: unknown = null;
    try {
      await api.getInstallation(101);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect((caught as GitHubTargetApiError).status).toBe('network');
  });
});
