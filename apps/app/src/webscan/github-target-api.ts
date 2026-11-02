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
 */

const GITHUB_API = 'https://api.github.com';
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

/** The shape of the account of an installation or of a repository. */
interface GitHubAccountPayload {
  id?: number;
  login?: string;
}

/** The shape of the installation record of the App. */
interface InstallationPayload {
  id?: number;
  account?: GitHubAccountPayload | null;
  suspended_at?: string | null;
  permissions?: { issues?: string } | null;
}

/** The shape of a repository record. */
interface RepositoryPayload {
  id?: number;
  name?: string;
  private?: boolean;
  visibility?: string;
  owner?: GitHubAccountPayload | null;
}

/** The shape of the repository list of one installation. */
interface RepositoryListPayload {
  total_count?: number;
  repositories?: RepositoryPayload[];
}

/** The shape of the access token of one installation. */
interface InstallationTokenPayload {
  token?: string;
}

/** Builds the production api of the alert target. */
export function createGitHubTargetApi(options: GitHubTargetApiOptions): GitHubTargetApi {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  /** One GitHub call. The reply body is only read when the call succeeded. */
  async function call(method: 'GET' | 'POST', url: string, token: string): Promise<unknown> {
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
    const payload = (await call(
      'POST',
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      appJwt(),
    )) as InstallationTokenPayload;
    const token = payload.token;
    if (typeof token !== 'string' || token === '') {
      throw new GitHubTargetApiError('network');
    }
    return token;
  }

  /** Maps a repository record onto the shape the verification reads. */
  function toRepository(payload: RepositoryPayload): GitHubTargetRepository {
    const visibility = payload.visibility;
    return {
      id: payload.id ?? 0,
      owner: payload.owner?.login ?? '',
      name: payload.name ?? '',
      private: payload.private === true,
      ownerAccountId: payload.owner?.id ?? 0,
      visibility:
        visibility === 'private' || visibility === 'internal' || visibility === 'public'
          ? visibility
          : payload.private === true
            ? 'private'
            : 'public',
    };
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
        let payload: RepositoryListPayload;
        try {
          payload = (await response.json()) as RepositoryListPayload;
        } catch {
          // A body that is not JSON is a broken answer, never a raw failure:
          // the call of the api throws the class of the failure and nothing else.
          throw new GitHubTargetApiError('network');
        }
        // Valid JSON of the wrong shape (null, a list that is not a list) is as broken
        // an answer as a body that is not JSON.
        const list: unknown = payload === null ? null : payload?.repositories ?? [];
        if (!Array.isArray(list)) throw new GitHubTargetApiError('network');
        for (const repository of list) {
          repositories.push(toRepository(repository));
        }
        nextUrl = nextLink(response);
      }
      return repositories;
    },

    async getInstallation(installationId: number): Promise<GitHubTargetInstallation> {
      const payload = (await call(
        'GET',
        `${GITHUB_API}/app/installations/${installationId}`,
        appJwt(),
      )) as InstallationPayload;
      const accountId = payload.account?.id;
      if (typeof accountId !== 'number') {
        throw new GitHubTargetApiError('network');
      }
      return {
        id: payload.id ?? installationId,
        accountId,
        accountLogin: payload.account?.login ?? '',
        suspended: Boolean(payload.suspended_at),
        issuesWrite: payload.permissions?.issues === 'write',
      };
    },

    async getRepository(
      installationId: number,
      owner: string,
      name: string,
    ): Promise<GitHubTargetRepository> {
      const token = await installationToken(installationId);
      const payload = (await call(
        'GET',
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        token,
      )) as RepositoryPayload;
      return toRepository(payload);
    },
  };
}
