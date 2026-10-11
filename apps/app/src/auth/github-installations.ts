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

/**
 * Lists the installation IDs a signed-in GitHub user can access.
 * Paginates GET /user/installations and never exposes or leaks the accessToken.
 */
export async function listUserInstallationIds(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<number[]> {
  const installationIds: number[] = [];
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
      installations?: Array<{ id: number }>;
    };

    if (Array.isArray(payload.installations)) {
      for (const inst of payload.installations) {
        if (typeof inst.id === 'number') {
          installationIds.push(inst.id);
        }
      }
    }

    const linkHeader = response.headers.get('Link') ?? response.headers.get('link');
    nextUrl = parseNextLink(linkHeader);
  }

  return installationIds;
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
