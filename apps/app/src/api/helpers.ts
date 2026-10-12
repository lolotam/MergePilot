import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { ROLES, type Role } from '../core/types.js';
import { setRequestLogUser } from '../server/log-context.js';

export interface BetterAuthDbAdapter {
  findOne<T = Record<string, unknown>>(query: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
  }): Promise<T | null>;
  findMany<T = Record<string, unknown>>(query: {
    model: string;
    where?: Array<{ field: string; value: unknown }>;
  }): Promise<T[]>;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({
    error: { code, message },
  });
}

export function extractHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, val] of Object.entries(request.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }
  return headers;
}

export async function getAuthSession(
  request: FastifyRequest,
  auth: Auth,
): Promise<{ user: { id: string; email: string; name?: string | null; image?: string | null | undefined } } | null> {
  const headers = extractHeaders(request);
  const session = await auth.api.getSession({ headers });
  if (!session || !session.user) {
    return null;
  }
  setRequestLogUser(request, session.user.id);
  return session;
}

export async function getUserGitHubAccount(
  auth: Auth,
  userId: string,
): Promise<{ linked: boolean; accessToken: string | null }> {
  const ctx = (await auth.$context) as unknown as { adapter: BetterAuthDbAdapter };
  const account = await ctx.adapter.findOne<{
    id: string;
    userId: string;
    providerId: string;
    accessToken?: string | null;
  }>({
    model: 'account',
    where: [
      { field: 'userId', value: userId },
      { field: 'providerId', value: 'github' },
    ],
  });

  if (!account) {
    return { linked: false, accessToken: null };
  }

  // GitHub App user tokens expire after 8 hours; Better Auth refreshes them here when needed.
  try {
    const fresh = (await auth.api.getAccessToken({ body: { accountId: account.id, userId } })) as
      | { accessToken?: string }
      | null;
    if (fresh?.accessToken) return { linked: true, accessToken: fresh.accessToken };
  } catch {
    // fall back to the stored token below; GitHub will reject it if it truly expired
  }

  return {
    linked: true,
    accessToken: account.accessToken ?? null,
  };
}

export interface UserWorkspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export async function getUserWorkspaces(
  auth: Auth,
  userId: string,
): Promise<UserWorkspace[]> {
  const ctx = (await auth.$context) as unknown as { adapter: BetterAuthDbAdapter };

  const members = await ctx.adapter.findMany<{
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  }>({
    model: 'member',
    where: [{ field: 'userId', value: userId }],
  });

  const workspaces: UserWorkspace[] = [];

  for (const m of members) {
    if (!ROLES.includes(m.role as Role)) continue;
    const org = await ctx.adapter.findOne<{
      id: string;
      name: string;
      slug: string;
    }>({
      model: 'organization',
      where: [{ field: 'id', value: m.organizationId }],
    });

    if (org) {
      workspaces.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: m.role as Role,
      });
    }
  }

  return workspaces;
}

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

function sanitizeSecret(message: string, secret: string): string {
  if (!secret) return message;
  return message.replaceAll(secret, '[REDACTED]');
}

export interface RawGitHubInstallation {
  id: number;
  account: { login: string; type: string };
  repository_selection: 'all' | 'selected';
  suspended_at?: string | null;
}

export async function fetchUserGitHubInstallations(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<RawGitHubInstallation[]> {
  const results: RawGitHubInstallation[] = [];
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
      throw new Error(`Failed to fetch user installations: ${sanitizeSecret(origMsg, accessToken)}`, {
        cause: err,
      });
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore read error
      }
      const safeError = sanitizeSecret(errorBody, accessToken);
      throw new Error(`GitHub API returned ${response.status}${safeError ? `: ${safeError}` : ''}`);
    }

    const payload = (await response.json()) as {
      total_count?: number;
      installations?: RawGitHubInstallation[];
    };

    if (Array.isArray(payload.installations)) {
      results.push(...payload.installations);
    }

    const linkHeader = response.headers.get('Link') ?? response.headers.get('link');
    nextUrl = parseNextLink(linkHeader);
  }

  return results;
}
