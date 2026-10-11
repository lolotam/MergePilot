import type { FastifyReply, FastifyRequest } from 'fastify';
import { roleAtLeast, type Role } from '../core/types.js';
import type { Auth } from './auth.js';
import { getAuthContext } from './fastify.js';

/**
 * Fastify preHandler that reads workspaceId from route params,
 * resolves AuthContext, replies 401 when not signed in,
 * 403 when signed in but not a member or below the required role,
 * and attaches request.auth.
 */
export function requireRole(required: Role, authOverride?: Auth) {
  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const auth = authOverride ?? request.server.auth;
    if (!auth) {
      throw new Error('Auth instance not found on server or passed to requireRole');
    }

    const rawHeaders = new Headers();
    for (const [key, val] of Object.entries(request.headers)) {
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        for (const v of val) rawHeaders.append(key, v);
      } else {
        rawHeaders.set(key, val);
      }
    }

    const session = await auth.api.getSession({ headers: rawHeaders });
    if (!session || !session.user) {
      reply.status(401).send({ error: 'Unauthorized', message: 'Not signed in' });
      return;
    }

    const params = request.params as { workspaceId?: string } | undefined;
    const workspaceId = params?.workspaceId;
    if (!workspaceId) {
      reply.status(403).send({ error: 'Forbidden', message: 'Workspace ID missing' });
      return;
    }

    const context = await getAuthContext(request, auth, workspaceId);
    if (!context) {
      reply.status(403).send({ error: 'Forbidden', message: 'Not a member of this workspace' });
      return;
    }

    if (!roleAtLeast(context.role, required)) {
      reply.status(403).send({
        error: 'Forbidden',
        message: `Role ${required} required, but user has ${context.role}`,
      });
      return;
    }

    request.auth = context;
  };
}
