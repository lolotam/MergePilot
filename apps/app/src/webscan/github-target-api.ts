import { sign as cryptoSign } from 'node:crypto';
import { listUserInstallations } from '../auth/github-installations.js';
import {
  GitHubTargetApiError,
  type GitHubTargetApi,
  type GitHubTargetApiStatus,
  type GitHubTargetInstallation,
  type GitHubTargetRepository,
} from './github-target.js';

/**
 * The production GitHub boundary of the alert target (ADR-0052 section 8).
 *
 * It is the only file that talks to GitHub. Every call is made with `fetch`, so
 * the class of a failure is known exactly: a `404`, a `403`, a `5xx`, a timeout
 * and a network error are told apart and nothing else is guessed.
 *
 * A token never reaches a log, an error or a response: the body of a GitHub
 * reply is never read into an error, and the only thing an error carries is its
 * class.
 *
 * Every request goes to the origin of the GitHub api and to no other one, so a
 * page that names another host never carries a bearer token out of here.
 */

const GITHUB_API = 'https://api.github.com';
/** The one origin a request of this api is allowed to go to. */
const GITHUB_API_ORIGIN = new URL(GITHUB_API).origin;
const USER_AGENT = 'MergePilot';
const API_VERSION = '2022-11-28';
/** The App jwt lives for ten minutes at most; GitHub refuses anything longer. */
const APP_JWT_LIFETIME_SECONDS = 600;

/** The options of the production api. */
export interface GitHubTargetApiOptions {
  /** The id of the GitHub App. */
  appId: string;
  /** The private key of the GitHub App, as a PEM. */
  privateKey: string;
  /** Test seam: the fetch the api uses. */
  fetchFn?: typeof fetch;
  /** The timeout of one call, in milliseconds. */
  timeoutMs?: number;
  /** Test seam: the clock of the app jwt. */
  now?: () => Date;
}

/** The status class of an HTTP reply. */
function statusOf(status: number): GitHubTargetApiStatus {
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'forbidden';
  if (status >= 500) return 'server_error';
  return 'forbidden';
}

/** The name of a thrown value, without trusting its shape. */
function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return '';
  const name = (error as { name: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/**
 * Refuses a url that does not go to the GitHub api of this api.
 *
 * The bearer token of the administrator travels with every page of a listing,
 * so a page that names another origin (a malformed or a hostile `Link` header)
 * is refused before the token leaves this process.
 */
function assertGitHubOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitHubTargetApiError('network');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== GITHUB_API_ORIGIN) {
    throw new GitHubTargetApiError('network');
  }
}

/** The url of a fetch argument, whatever shape it has. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A record of GitHub, or nothing when the value is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A positive safe integer, or nothing when the value is not one. */
function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** A non-empty string, or nothing when the value is not one. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Whether the installation reports itself as suspended. */
function isSuspended(suspendedAt: unknown): boolean {
  if (typeof suspendedAt === 'string') return suspendedAt !== '';
  return suspendedAt !== undefined && suspendedAt !== null;
}

/** Whether the installation grants the App `issues: write`. */
function grantsIssuesWrite(permissions: unknown): boolean {
  const record = asRecord(permissions);
  if (record === null) return false;
  const issues = record['issues'];
  return typeof issues === 'string' && issues === 'write';
}

/**
 * The strict parser of a repository record.
 *
 * Every field the proof rests on is checked, so a record without an id, without
 * a name or without an owner is a broken answer and never a repository with
 * the id 0.
 */
function parseRepository(payload: unknown): GitHubTargetRepository {
  const record = asRecord(payload);
  if (record === null) throw new GitHubTargetApiError('network');
  const id = positiveInteger(record['id']);
  const name = nonEmptyString(record['name']);
  const owner = asRecord(record['owner']);
  const ownerId = owner === null ? null : positiveInteger(owner['id']);
  const ownerLogin = owner === null ? null : nonEmptyString(owner['login']);
  const isPrivate = record['private'];
  if (
    id === null ||
    name === null ||
    ownerId === null ||
    ownerLogin === null ||
    (isPrivate !== undefined && typeof isPrivate !== 'boolean')
  ) {
    throw new GitHubTargetApiError('network');
  }
  const visibility = record['visibility'];
  return {
    id,
    owner: ownerLogin,
    name,
    private: isPrivate === true,
    ownerAccountId: ownerId,
    visibility:
      visibility === 'private' || visibility === 'internal' || visibility === 'public'
        ? visibility
        : isPrivate === true
          ? 'private'
          : 'public',
  };
}

/**
 * The strict parser of the record of an installation.
 *
 * The ids of GitHub are the identity of the installation and of its account, so
 * they are checked like every other identity: a record without them is a
 * broken answer and never an installation with the id 0.
 */
function parseInstallation(payload: unknown): GitHubTargetInstallation {
  const record = asRecord(payload);
  if (record === null) throw new GitHubTargetApiError('network');
  const id = positiveInteger(record['id']);
  const account = asRecord(record['account']);
  const accountId = account === null ? null : positiveInteger(account['id']);
  const accountLogin = account === null ? null : nonEmptyString(account['login']);
  if (id === null || accountId === null || accountLogin === null) {
    throw new GitHubTargetApiError('network');
  }
  return {
    id,
    accountId,
    accountLogin,
    suspended: isSuspended(record['suspended_at']),
    issuesWrite: grantsIssuesWrite(record['permissions']),
  };
}

/**
 * The list of the repositories of a reply.
 *
 * A reply without a list is a broken answer and never an empty list: an empty
 * list is a proof that the installation sees nothing, and it has to be said.
 */
function repositoryListOf(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (record === null) throw new GitHubTargetApiError('network');
  const list: unknown = record['repositories'];
  if (!Array.isArray(list)) throw new GitHubTargetApiError('network');
  return list;
}

/** Base64url without padding, as the jwt needs it. */
function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/**
 * The App jwt of the GitHub App.
 *
 * GitHub accepts an RS256 jwt whose subject is the App id and whose lifetime is
 * at most ten minutes. The private key never leaves this function.
 */
function createAppJwt(appId: string, privateKey: string, at: Date): string {
  const issuedAt = Math.floor(at.getTime() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        iat: issuedAt - 60,
        exp: issuedAt + APP_JWT_LIFETIME_SECONDS,
        iss: appId,
      }),
    ),
  );
  const signature = cryptoSign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    privateKey,
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Builds the production api of the alert target. */
export function createGitHubTargetApi(options: GitHubTargetApiOptions): GitHubTargetApi {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  /** One GitHub call. The reply body is only read when the call succeeded. */
  async function call(method: 'GET' | 'POST', url: string, token: string): Promise<unknown> {
    // The credential of the call goes with it, so a url of another origin is
    // refused before the call leaves this process.
    assertGitHubOrigin(url);
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = errorName(error);
      throw new GitHubTargetApiError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      );
    }
    if (!response.ok) {
      throw new GitHubTargetApiError(statusOf(response.status));
    }
    try {
      const payload: unknown = await response.json();
      return payload;
    } catch {
      throw new GitHubTargetApiError('network');
    }
  }

  /** The App jwt of every call that acts as the App itself. */
  function appJwt(): string {
    try {
      return createAppJwt(options.appId, options.privateKey, now());
    } catch {
      // A private key the App cannot sign with is a configuration failure, and
      // it proves nothing about the target.
      throw new GitHubTargetApiError('network');
    }
  }

  /** The access token of one installation. */
  async function installationToken(installationId: number): Promise<string> {
    const payload = asRecord(
      await call(
        'POST',
        `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
        appJwt(),
      ),
    );
    const token = payload === null ? null : payload['token'];
    if (typeof token !== 'string' || token === '') {
      throw new GitHubTargetApiError('network');
    }
    return token;
  }

  /** The next page of a paginated list, as the Link header names it. */
  function nextLink(response: Response): string | null {
    const link = response.headers.get('Link') ?? response.headers.get('link');
    if (link === null) return null;
    for (const part of link.split(',')) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match !== null && match[2] === 'next' && match[1] !== undefined) return match[1];
    }
    return null;
  }

  return {
    async listUserInstallations(userToken: string) {
      // The shared listing knows the pagination and the redaction of the token,
      // so it is reused. The wrapper only remembers the status of the reply, so
      // a failure can be classified like every other one.
      let lastStatus: number | undefined;
      let timedOut = false;
      const trackingFetch: typeof fetch = async (input, init) => {
        // Every page starts from a clean slate: the status of an earlier page
        // never classifies the failure of a later one.
        lastStatus = undefined;
        timedOut = false;
        // The token of the administrator goes with every page of the listing,
        // so a page of another origin is refused before the token leaves.
        assertGitHubOrigin(urlOf(input));
        try {
          // The shared listing sets no deadline of its own: every page of it gets
          // the same timeout as every other call, so a hanging GitHub is a refusal.
          const response = await fetchFn(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
          lastStatus = response.status;
          return response;
        } catch (error) {
          const name = errorName(error);
          timedOut = name === 'TimeoutError' || name === 'AbortError';
          throw error;
        }
      };
      try {
        return await listUserInstallations(userToken, trackingFetch);
      } catch {
        // A timeout is a timeout, whatever an earlier page of the listing
        // answered.
        if (timedOut) {
          throw new GitHubTargetApiError('timeout');
        }
        // No status at all is a transport failure, and a status of a successful
        // reply that failed afterwards (a truncated body) is a broken answer:
        // neither of them is a refusal of GitHub.
        if (lastStatus === undefined || (lastStatus >= 200 && lastStatus < 300)) {
          throw new GitHubTargetApiError('network');
        }
        throw new GitHubTargetApiError(statusOf(lastStatus));
      }
    },

    async listInstallationRepositories(userToken: string, installationId: number) {
      const repositories: GitHubTargetRepository[] = [];
      let nextUrl: string | null =
        `${GITHUB_API}/user/installations/${installationId}/repositories?per_page=100`;
      while (nextUrl !== null) {
        // The token of the administrator goes with every page of the listing,
        // so a page of another origin is refused before the token leaves.
        assertGitHubOrigin(nextUrl);
        let response: Response;
        try {
          response = await fetchFn(nextUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${userToken}`,
              'X-GitHub-Api-Version': API_VERSION,
              'User-Agent': USER_AGENT,
            },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const name = errorName(error);
          throw new GitHubTargetApiError(
            name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
          );
        }
        if (!response.ok) {
          throw new GitHubTargetApiError(statusOf(response.status));
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          // A body that is not JSON is a broken answer, never a raw failure:
          // the call of the api throws the class of the failure and nothing else.
          throw new GitHubTargetApiError('network');
        }
        // Valid JSON of the wrong shape (null, a list that is not a list) is as broken
        // an answer as a body that is not JSON.
        const list = repositoryListOf(payload);
        for (const repository of list) {
          repositories.push(parseRepository(repository));
        }
        nextUrl = nextLink(response);
      }
      return repositories;
    },

    async getInstallation(installationId: number): Promise<GitHubTargetInstallation> {
      const payload = await call(
        'GET',
        `${GITHUB_API}/app/installations/${installationId}`,
        appJwt(),
      );
      const installation = parseInstallation(payload);
      // The reply has to be the record of the installation that was asked for: a reply
      // about another installation proves nothing about this one.
      if (installation.id !== installationId) throw new GitHubTargetApiError('network');
      return installation;
    },

    async getRepository(
      installationId: number,
      owner: string,
      name: string,
    ): Promise<GitHubTargetRepository> {
      const token = await installationToken(installationId);
      const payload = await call(
        'GET',
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        token,
      );
      const repository = parseRepository(payload);
      // Same for the repository: the reply names the repository that was asked for.
      if (
        repository.owner.toLowerCase() !== owner.toLowerCase() ||
        repository.name.toLowerCase() !== name.toLowerCase()
      ) {
        throw new GitHubTargetApiError('network');
      }
      return repository;
    },
  };
}
