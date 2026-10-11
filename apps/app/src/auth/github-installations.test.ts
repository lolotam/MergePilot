import { describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { listUserInstallationIds, getUserGitHubAccessToken } from './github-installations.js';
import * as schema from './schema.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('github installations listing', () => {
  const secretToken = 'ghu_super_secret_github_token_123456';

  it('lists installation ids from a single page', async () => {
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: `Bearer ${secretToken}`,
        }),
      );
      return new Response(
        JSON.stringify({
          total_count: 2,
          installations: [{ id: 101 }, { id: 102 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const ids = await listUserInstallationIds(secretToken, fakeFetch);
    expect(ids).toEqual([101, 102]);
  });

  it('paginates across multiple pages using Link header', async () => {
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (!urlStr.includes('page=2')) {
        return new Response(
          JSON.stringify({
            total_count: 3,
            installations: [{ id: 101 }, { id: 102 }],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              Link: '<https://api.github.com/user/installations?page=2>; rel="next", <https://api.github.com/user/installations?page=2>; rel="last"',
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          total_count: 3,
          installations: [{ id: 103 }],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    });

    const ids = await listUserInstallationIds(secretToken, fakeFetch);
    expect(ids).toEqual([101, 102, 103]);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('never leaks the token on error', async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    let caughtError: Error | null = null;
    try {
      await listUserInstallationIds(secretToken, fakeFetch);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).not.toContain(secretToken);
  });

  it('never leaks the token when fetch throws network error', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error(`Network failure connecting with ${secretToken}`);
    });

    let caughtError: Error | null = null;
    try {
      await listUserInstallationIds(secretToken, fakeFetch);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).not.toContain(secretToken);
  });

  it('reads user GitHub access token from the account table', async () => {
    const pglite = new PGlite();
    const migrationSql = readFileSync(join(__dirname, '../../migrations/0002_auth.sql'), 'utf-8');
    await pglite.exec(migrationSql);

    const db = drizzle(pglite, { schema });

    await db.insert(schema.user).values({
      id: 'user-1',
      name: 'Developer',
      email: 'dev@example.com',
      emailVerified: true,
    });

    await db.insert(schema.account).values({
      id: 'acc-1',
      accountId: 'gh-999',
      providerId: 'github',
      userId: 'user-1',
      accessToken: secretToken,
    });

    const token = await getUserGitHubAccessToken(db, 'user-1');
    expect(token).toBe(secretToken);

    const missingToken = await getUserGitHubAccessToken(db, 'nonexistent-user');
    expect(missingToken).toBeNull();
  }, 30000);
});
