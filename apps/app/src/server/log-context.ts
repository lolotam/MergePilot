import type { FastifyRequest } from 'fastify';

/** Who a request acted for, attached by the auth guards and read by the completion log line. */
export interface RequestLogContext {
  userId?: string;
  workspaceId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    logContext?: RequestLogContext;
  }
}

/** Records the signed-in user (and workspace, when known) for this request's completion line. */
export function setRequestLogUser(
  request: FastifyRequest,
  userId: string,
  workspaceId?: string,
): void {
  request.logContext = {
    ...request.logContext,
    userId,
    ...(workspaceId ? { workspaceId } : {}),
  };
}
