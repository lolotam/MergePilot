import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/auth.js';
import type { AppConfig } from '../core/config.js';
import { setRequestLogUser } from '../server/log-context.js';

export interface AdminUser {
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AdminUser;
  }
}

/** True only for a verified email that is in the configured platform admin list. */
export function isUserPlatformAdmin(
  user: { email?: string | null; emailVerified?: boolean | null } | null | undefined,
  platformAdmins: readonly string[] | undefined,
): boolean {
  if (!user?.email || user.emailVerified !== true || !platformAdmins?.length) {
    return false;
  }
  return platformAdmins.includes(user.email.trim().toLowerCase());
}

function toHeaders(request: FastifyRequest): Headers {
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

/**
 * Fastify preHandler for the platform operator area. Anyone who is not a signed-in platform
 * admin with a verified email gets the regular 404, so the admin area is not revealed.
 */
export function requirePlatformAdmin(
  config: Pick<AppConfig, 'platformAdmins'>,
  authOverride?: Auth,
) {
  return async function platformAdminGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const auth = authOverride ?? request.server.auth;
    if (!auth) {
      throw new Error('Auth instance not found on server or passed to requirePlatformAdmin');
    }

    const session = await auth.api.getSession({ headers: toHeaders(request) });
    if (!session?.user || !isUserPlatformAdmin(session.user, config.platformAdmins)) {
      reply.callNotFound();
      return reply;
    }

    request.adminUser = { id: session.user.id };
    setRequestLogUser(request, session.user.id);
    return undefined;
  };
}
