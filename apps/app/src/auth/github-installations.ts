import { eq, and } from 'drizzle-orm';
import { account } from './schema.js';

/**
 * Parses the GitHub `Link` pagination header and returns the 'next' URL if present.
 */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next' && match[1]) {
      return match[1];
    }
  }
  return null;
}

function sanitizeMessage(message: string, secret: string): string {
  if (!secret) return message;
  return message.replaceAll(secret, '[REDACTED]');
}

/** An installation of this GitHub App that the signed-in user can access, as GitHub reports it. */
export interface UserInstallation {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

/**
 * Lists the installation IDs a signed-in GitHub user can access.
 * Paginates GET /user/installations and never exposes or leaks the accessToken.
 */
export async function listUserInstallationIds(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<number[]> {
  return (await listUserInstallations(accessToken, fetchFn)).map((i) => i.id);
}

/**
 * Lists the installations a signed-in GitHub user can access, with the account details GitHub
 * reports. Linking uses these when the `installation` webhook never reached us (for example,
 * the App was installed before its webhook URL was configured).
 */
export async function listUserInstallations(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<UserInstallation[]> {
  const installations: UserInstallation[] = [];
  let nextUrl: string | null = 'https://api.github.com/user/installations?per_page=100';

  while (nextUrl) {
    let response: Response;
    try {
      response = await fetchFn(nextUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'MergePilot',
        },
      });
    } catch (err) {
      if (err instanceof Error && accessToken && err.message.includes(accessToken)) {
        err.message = err.message.replaceAll(accessToken, '[REDACTED]');
      }
      const origMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch user installations: ${sanitizeMessage(origMsg, accessToken)}`, {
        cause: err,
      });
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // Ignore read error
      }
      const safeError = sanitizeMessage(errorBody, accessToken);
      throw new Error(
        `GitHub API returned ${response.status}${safeError ? `: ${safeError}` : ''}`,
      );
    }

    const payload = (await response.json()) as {
      total_count?: number;
      installations?: Array<{
        id: number;
        account?: { login?: string; type?: string } | null;
        repository_selection?: string;
        suspended_at?: string | null;
      }>;
    };

    if (Array.isArray(payload.installations)) {
      for (const inst of payload.installations) {
        if (typeof inst.id === 'number') {
          installations.push({
            id: inst.id,
            accountLogin: inst.account?.login ?? '',
            accountType: inst.account?.type === 'Organization' ? 'Organization' : 'User',
            repositorySelection: inst.repository_selection === 'all' ? 'all' : 'selected',
            suspended: Boolean(inst.suspended_at),
          });
        }
      }
    }

    const linkHeader = response.headers.get('Link') ?? response.headers.get('link');
    nextUrl = parseNextLink(linkHeader);
  }

  return installations;
}

export interface AccountTokenReader {
  select(fields: { accessToken: typeof account.accessToken }): {
    from(table: typeof account): {
      where(clause: unknown): {
        limit(count: number): Promise<Array<{ accessToken: string | null }>>;
      };
    };
  };
}

export async function getUserGitHubAccessToken(
  db: AccountTokenReader,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
    .limit(1);

  const match = rows[0];
  if (!match || !match.accessToken) {
    return null;
  }
  return match.accessToken;
}
