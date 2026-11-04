import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubTargetApiError } from './github-target.js';
import { createGitHubTargetApi } from '@mergepilot/github';

/**
 * The tests of the production GitHub boundary of the alert target.
 *
 * The transport is a fake, so no test ever reaches GitHub. The private key of
 * the App is generated at run time, so no key material ever reaches the source.
 */

/** A token-shaped value that is built at run time and must never leak. */
const HOSTILE_TOKEN = ['gh', 'p', '_', 'hostile', 'token', 'value'].join('');

/** The access token of an installation, built at run time. */
const INSTALLATION_TOKEN = ['gh', 's', '_', 'installation', 'token', 'value'].join('');

/** A key the App cannot sign with, built at run time. */
const UNUSABLE_KEY = ['not', 'a', 'signing', 'key'].join('-');

/** The url of the second page of the listing of the installations. */
const SECOND_PAGE = 'https://api.github.com/user/installations?per_page=100&page=2';

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

/** The init of one call of the fake transport. */
interface CallInit {
  headers: Record<string, string>;
}

/** One call of the fake transport. */
interface Call {
  input: string | URL | Request;
  init?: CallInit | undefined;
}

/** Builds a fake transport that answers by the path of the url. */
function fakeFetch(replies: Record<string, Reply | (() => never)>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: CallInit) => {
    calls.push({ input, init });
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace('https://api.github.com', '');
    const entry = Object.entries(replies).find(([candidate]) => path.startsWith(candidate));
    if (entry === undefined) {
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const reply = entry[1];
    if (typeof reply === 'function') {
      // The transport of a failure: it throws and never answers.
      return reply();
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
  return { fetchFn, calls };
}

/** The api under test, with the fake transport. */
function apiWith(replies: Record<string, Reply | (() => never)>) {
  const { fetchFn, calls } = fakeFetch(replies);
  return {
    fetchFn,
    calls,
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
    const { api, calls } = apiWith({
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
    const headers = calls[0]?.init?.headers;
    expect(headers?.Authorization).toMatch(/^Bearer /);
    expect(headers?.Authorization).not.toContain(HOSTILE_TOKEN);
  });

  it('reads a repository with the token of the installation', async () => {
    const { api, fetchFn } = apiWith({
      '/app/installations/101/access_tokens': { status: 201, body: { token: INSTALLATION_TOKEN } },
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
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      call += 1;
      urls.push(typeof input === 'string' ? input : input.toString());
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
    // Every page of the listing goes to the GitHub api and to no other host.
    expect(urls.every((url) => url.startsWith('https://api.github.com'))).toBe(true);
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

  it('gives up on a GitHub that hangs while the installations are listed', async () => {
    let signalSeen = false;
    const api = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      timeoutMs: 20,
      // A GitHub that never answers: only the deadline of the request ends the call.
      fetchFn: ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          signalSeen = init?.signal instanceof AbortSignal;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as unknown as typeof fetch,
    });
    let caught: unknown = null;
    try {
      await api.listUserInstallations(HOSTILE_TOKEN);
    } catch (error: unknown) {
      caught = error;
    }
    expect(signalSeen).toBe(true);
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect((caught as GitHubTargetApiError).status).toBe('timeout');
    expect(String(caught)).not.toContain(HOSTILE_TOKEN);
  });

  it.each([['null', 'null'], ['a repository list that is not a list', '{"repositories":{}}']])(
    'refuses valid JSON of the wrong shape from the repository listing (%s)',
    async (_name, body) => {
      const api = createGitHubTargetApi({
        appId: '12345',
        privateKey: PRIVATE_KEY,
        fetchFn: (async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      });
      let caught: unknown = null;
      try {
        await api.listInstallationRepositories(HOSTILE_TOKEN, 101);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubTargetApiError);
      expect((caught as GitHubTargetApiError).status).toBe('network');
    },
  );

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
      privateKey: UNUSABLE_KEY,
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

  it('calls a broken body of the repositories a network failure', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('this is not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const api = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    let caught: unknown = null;
    try {
      await api.listInstallationRepositories(HOSTILE_TOKEN, 101);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as GitHubTargetApiError).status).toBe('network');
  });
});

describe('the pages of the listing of the installations', () => {
  /** The api under test, with a transport that answers by the url of the call. */
  function apiWithPages(fetchFn: typeof fetch, timeoutMs: number) {
    return createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn,
      timeoutMs,
    });
  }

  /** The reply of a first page that names a second one. */
  function firstPage(): Response {
    return new Response(JSON.stringify({ total_count: 0, installations: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Link: `<${SECOND_PAGE}>; rel="next"`,
      },
    });
  }

  it('gives up on a later page that hangs past the deadline', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('page=2')) {
        // A second page that never answers: only the deadline of the request
        // ends the call.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
        });
      }
      return firstPage();
    });
    const api = apiWithPages(fetchFn as unknown as typeof fetch, 20);

    let caught: unknown = null;
    try {
      await api.listUserInstallations(HOSTILE_TOKEN);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect((caught as GitHubTargetApiError).status).toBe('timeout');
    // The first page answered: the failure is the failure of the second one.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('calls a later page with a broken body a network failure', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('page=2')) {
        return new Response('this is not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return firstPage();
    });
    const api = apiWithPages(fetchFn as unknown as typeof fetch, 1_000);

    let caught: unknown = null;
    try {
      await api.listUserInstallations(HOSTILE_TOKEN);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect((caught as GitHubTargetApiError).status).toBe('network');
    // The first page answered: the failure is the failure of the second one.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('tells a refusal of a later page from a broken one', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('page=2')) {
        return new Response(JSON.stringify({ message: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return firstPage();
    });
    const api = apiWithPages(fetchFn as unknown as typeof fetch, 1_000);

    let caught: unknown = null;
    try {
      await api.listUserInstallations(HOSTILE_TOKEN);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect((caught as GitHubTargetApiError).status).toBe('forbidden');
  });
});
