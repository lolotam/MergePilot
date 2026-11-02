import { eq, and } from 'drizzle-orm';
import { account } from './schema.js';

export { listUserInstallations, listUserInstallationIds, type UserInstallation } from '@mergepilot/github';

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
