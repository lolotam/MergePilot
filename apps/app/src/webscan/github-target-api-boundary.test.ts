import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubTargetApiError } from './github-target.js';
import { createGitHubTargetApi, isSignablePrivateKey } from './github-target-api.js';
import { createGitHubTargetVerifier } from './github-target-verify.js';
import { ADMIN, APPROVED, deps } from './github-target.fixtures.js';

/**
 * The tests of the boundary of the production GitHub api (ADR-0052 section 8).
 *
 * Two invariants of the boundary are proved here: a request never leaves for
 * another host, and a record of GitHub is never believed before it is checked.
 * The transport is a fake, so no test ever reaches GitHub, and the private key
 * of the App is generated at run time, so no key material reaches the source.
 */

/** A token-shaped value that is built at run time and must never leak. */
const HOSTILE_TOKEN = ['gh', 'p', '_', 'hostile', 'token', 'value'].join('');

/** The access token of an installation, built at run time. */
const INSTALLATION_TOKEN = ['gh', 's', '_', 'installation', 'token', 'value'].join('');

/** The origin of the GitHub api. */
const GITHUB_ORIGIN = 'https://api.github.com';

/** The origin of a host that has no business with the token of the administrator. */
const FOREIGN_ORIGIN = 'https://evil.example';

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

/** One answer of the fake transport: a reply, or a reply that depends on the url. */
type Answer = Reply | ((url: string) => Reply);

/** The fake transport: it answers by the path of the url of the call. */
function fakeFetch(replies: Record<string, Answer>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const path = url.replace(GITHUB_ORIGIN, '');
    const entry = Object.entries(replies).find(([candidate]) => path.startsWith(candidate));
    if (entry === undefined) {
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = entry[1];
    const reply = typeof answer === 'function' ? answer(url) : answer;
    const body = reply.body === undefined ? '{}' : JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
  return { fetchFn, calls };
}

/** The api under test, with the fake transport. */
function apiWith(replies: Record<string, Answer>) {
  const { fetchFn, calls } = fakeFetch(replies);
  const api = createGitHubTargetApi({
    appId: '12345',
    privateKey: PRIVATE_KEY,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { api, fetchFn, calls };
}

/** The error of a call that has to fail, or null when it did not fail. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

/** A reply of a page that names the next one. */
function pageWithNext(next: string, body: unknown): Reply {
  return {
    status: 200,
    body,
    headers: { Link: `<${next}>; rel="next"` },
  };
}

/** The pages of a listing that name a host that has no business with the token. */
const FOREIGN_PAGES: Array<[string, string]> = [
  ['another host', `${FOREIGN_ORIGIN}/user/installations?page=2`],
  ['a host that is not https', 'http://api.github.com/user/installations?page=2'],
];

/** The listings of repositories that are not a list of repositories. */
const BROKEN_LISTINGS: Array<[string, unknown]> = [
  ['a record that is not an object', { repositories: [null] }],
  [
    'a record without an id',
    { repositories: [{ name: 'demo', owner: { id: 401, login: 'acme' } }] },
  ],
  [
    'a record with an id of zero',
    { repositories: [{ id: 0, name: 'demo', owner: { id: 401, login: 'acme' } }] },
  ],
  [
    'a record with a name that is not a string',
    { repositories: [{ id: 7, name: 42, owner: { id: 401, login: 'acme' } }] },
  ],
  ['a record without an owner', { repositories: [{ id: 7, name: 'demo' }] }],
  ['a reply without a list of repositories', { total_count: 0 }],
];

/** The records of an installation that carry no identity of their own. */
const BROKEN_INSTALLATIONS: Array<[string, unknown]> = [
  [
    'an installation without an id',
    { account: { id: 401, login: 'acme' }, permissions: { issues: 'write' } },
  ],
  [
    'an installation whose account has no id',
    { id: 101, account: { login: 'acme' }, permissions: { issues: 'write' } },
  ],
];

describe('the origin of every call of the GitHub api', () => {
  it.each(FOREIGN_PAGES)(
    'refuses a page of the installations that names %s',
    async (_name, next) => {
      const { api, fetchFn, calls } = apiWith({
        '/user/installations': pageWithNext(next, { total_count: 0, installations: [] }),
      });

      const caught = await failure(api.listUserInstallations(HOSTILE_TOKEN));
      expect(caught).toBeInstanceOf(GitHubTargetApiError);
      expect((caught as GitHubTargetApiError).status).toBe('network');
      // The second page never left this process, so the token never left it.
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(calls.every((url) => url.startsWith(GITHUB_ORIGIN))).toBe(true);
      expect(String(caught)).not.toContain(HOSTILE_TOKEN);
    },
  );

  it('refuses a page of the repositories that names another host', async () => {
    const { api, fetchFn, calls } = apiWith({
      '/user/installations/101/repositories': pageWithNext(
        `${FOREIGN_ORIGIN}/user/installations/101/repositories?page=2`,
        { total_count: 0, repositories: [] },
      ),
    });

    const caught = await failure(api.listInstallationRepositories(HOSTILE_TOKEN, 101));
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect((caught as GitHubTargetApiError).status).toBe('network');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls.every((url) => url.startsWith(GITHUB_ORIGIN))).toBe(true);
    expect(String(caught)).not.toContain(HOSTILE_TOKEN);
  });

  it('paginates a page of the installations of the same origin', async () => {
    const { api, fetchFn, calls } = apiWith({
      '/user/installations': (url) =>
        url.includes('page=2')
          ? { status: 200, body: { total_count: 1, installations: [{ id: 101 }] } }
          : pageWithNext(`${GITHUB_ORIGIN}/user/installations?page=2`, {
              total_count: 1,
              installations: [],
            }),
    });

    const installations = await api.listUserInstallations(HOSTILE_TOKEN);
    expect(installations.map((installation) => installation.id)).toEqual([101]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls.every((url) => url.startsWith(GITHUB_ORIGIN))).toBe(true);
  });
});

describe('the shape of the records of GitHub', () => {
  it.each(BROKEN_LISTINGS)(
    'refuses a listing of repositories with %s',
    async (_name, body) => {
      const { api } = apiWith({
        '/user/installations/101/repositories': { status: 200, body },
      });

      const caught = await failure(api.listInstallationRepositories(HOSTILE_TOKEN, 101));
      expect(caught).toBeInstanceOf(GitHubTargetApiError);
      expect(caught).not.toBeInstanceOf(TypeError);
      expect((caught as GitHubTargetApiError).status).toBe('network');
    },
  );

  it('refuses a repository of a single call without an id', async () => {
    const { api } = apiWith({
      '/app/installations/101/access_tokens': {
        status: 201,
        body: { token: INSTALLATION_TOKEN },
      },
      '/repos/acme/demo': {
        status: 200,
        body: { name: 'demo', private: true, owner: { id: 401, login: 'acme' } },
      },
    });

    const caught = await failure(api.getRepository(101, 'acme', 'demo'));
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as GitHubTargetApiError).status).toBe('network');
  });

  it.each(BROKEN_INSTALLATIONS)('refuses %s', async (_name, body) => {
    const { api } = apiWith({ '/app/installations/101': { status: 200, body } });

    const caught = await failure(api.getInstallation(101));
    expect(caught).toBeInstanceOf(GitHubTargetApiError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as GitHubTargetApiError).status).toBe('network');
  });

  it('never verifies a target out of a record that is not a repository', async () => {
    // The real api behind the real verifier: a record that is not a repository
    // proves nothing, so no binding is ever written out of it.
    const { api } = apiWith({
      '/app/installations/101/access_tokens': {
        status: 201,
        body: { token: INSTALLATION_TOKEN },
      },
      '/app/installations/101': {
        status: 200,
        body: { id: 101, account: { id: 401, login: 'acme' }, permissions: { issues: 'write' } },
      },
      '/user/installations/101/repositories': {
        status: 200,
        body: { repositories: [{ id: 0, name: 'demo', owner: { id: 401, login: 'acme' } }] },
      },
    });

    const verifier = createGitHubTargetVerifier(deps(api));
    const result = await verifier.verifyRepository({
      adminUserId: ADMIN,
      owner: 'acme',
      name: 'demo',
      approved: APPROVED,
    });
    expect(result).toEqual({ ok: false, reason: 'unverifiable' });
  });

  it('refuses a record of another installation than the one that was asked for', async () => {
    const { fetchFn } = fakeFetch({
      '/app/installations/101': {
        status: 200,
        body: {
          id: 202,
          account: { id: 401, login: 'acme' },
          suspended_at: null,
          permissions: { issues: 'write' },
        },
      },
    });
    const api = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(api.getInstallation(101)).rejects.toBeInstanceOf(GitHubTargetApiError);
  });

  it('refuses a repository reply that names another repository than the one asked for', async () => {
    const { fetchFn } = fakeFetch({
      '/app/installations/101/access_tokens': { status: 201, body: { token: INSTALLATION_TOKEN } },
      '/repos/acme/demo': {
        status: 200,
        body: { id: 7, name: 'other', private: true, visibility: 'private', owner: { id: 401, login: 'acme' } },
      },
    });
    const api = createGitHubTargetApi({
      appId: '12345',
      privateKey: PRIVATE_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(api.getRepository(101, 'acme', 'demo')).rejects.toBeInstanceOf(GitHubTargetApiError);
  });

  it('tells a private key that can sign from one that cannot', () => {
    expect(isSignablePrivateKey(PRIVATE_KEY)).toBe(true);
    expect(isSignablePrivateKey('not-a-key')).toBe(false);
    // A base64 blob of the PEM is not a PEM.
    expect(isSignablePrivateKey(Buffer.from(PRIVATE_KEY).toString('base64'))).toBe(false);
    expect(isSignablePrivateKey('')).toBe(false);
    // Only an RSA key can sign the RS256 token of the App.
    const { privateKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(isSignablePrivateKey(ecKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toBe(false);
  });
});
