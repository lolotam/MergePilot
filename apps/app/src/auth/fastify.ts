import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getOrgAdapter } from 'better-auth/plugins/organization';
import { ROLES, type AuthContext, type Role } from '../core/types.js';
import type { Auth } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyInstance {
    auth?: Auth;
  }
}

/**
 * Converts incoming FastifyRequest to a Web Standard Request object.
 */
export function fastifyRequestToWebRequest(request: FastifyRequest): Request {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = forwardedProto
    ? (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() || request.protocol
    : request.protocol;

  const forwardedHost = request.headers['x-forwarded-host'];
  const host = forwardedHost
    ? (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() || request.hostname
    : request.headers.host ?? request.hostname;

  const url = new URL(request.url, `${protocol}://${host}`);

  const headers = new Headers();
  for (const [key, val] of Object.entries(request.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }

  let body: string | Uint8Array | undefined = undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.body !== undefined && request.body !== null) {
      if (typeof request.body === 'string' || Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
        body = request.body;
      } else {
        body = JSON.stringify(request.body);
      }
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}

/**
 * Streams a Web Standard Response back through FastifyReply, including Set-Cookie headers.
 */
export async function streamWebResponse(response: Response, reply: FastifyReply): Promise<void> {
  reply.status(response.status);

  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }
  }

  response.headers.forEach((val, key) => {
    if (key.toLowerCase() !== 'set-cookie') {
      reply.header(key, val);
    }
  });

  if (!response.body) {
    return reply.send();
  }

  const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  return reply.send(stream);
}

/**
 * Mounts Better Auth's handler at `/api/auth/*`.
 */
export function registerAuthRoutes(app: FastifyInstance, auth: Auth): void {
  if (!app.hasDecorator('auth')) {
    app.decorate('auth', auth);
  }

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const webRequest = fastifyRequestToWebRequest(request);
    const webResponse = await auth.handler(webRequest);
    return streamWebResponse(webResponse, reply);
  };

  app.all('/api/auth', handler);
  app.all('/api/auth/*', handler);
}

/**
 * Resolves session user and workspace membership role into an AuthContext.
 * Returns null when not signed in or not a member of workspaceId.
 */
export async function getAuthContext(
  request: FastifyRequest,
  auth: Auth,
  workspaceId: string,
): Promise<AuthContext | null> {
  const rawHeaders = new Headers();
  for (const [key, val] of Object.entries(request.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const v of val) rawHeaders.append(key, v);
    } else {
      rawHeaders.set(key, val);
    }
  }

  // Better Auth verifies the signed session cookie itself; never re-sign or accept bare tokens.
  const session = await auth.api.getSession({ headers: rawHeaders });
  if (!session || !session.user) {
    return null;
  }

  const authContext = (await auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0];
  const orgAdapter = getOrgAdapter(authContext);
  const member = await orgAdapter.findMemberByOrgId({
    userId: session.user.id,
    organizationId: workspaceId,
  });

  if (!member || !member.role) {
    return null;
  }

  if (!ROLES.includes(member.role as Role)) {
    return null;
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    workspaceId,
    role: member.role as Role,
  };
}
