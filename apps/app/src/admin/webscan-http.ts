import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ScanSettingsError } from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import { WebScanIdSchema } from '../api/contract-webscan.js';
import { WebScanScheduleError } from '../webscan/schedule.js';
import {
  WebScanAuthorizationError,
  WebScanConflictError,
  WebScanNotFoundError,
  WebScanPausedError,
} from '../webscan/store.js';

/**
 * The shared HTTP helpers of the website security scanner (ADR-0052).
 *
 * They live in their own file so the route files never import each other: the
 * registration file imports the route files, and a route file imports only this
 * one. Nothing here imports a route file, so the cycle cannot form.
 */

/** The Fastify preHandler `requirePlatformAdmin` returns (guard.ts). */
export type WebScanAdminGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

/** Answers 422 with the first issue of a schema rejection. Zod messages stay fixed. */
export function sendWebScanValidationError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const message = error.issues[0]?.message ?? 'Invalid request';
  return sendError(reply, 422, 'invalid_request', message);
}

/**
 * Maps the typed store errors of the scanner onto the admin error envelope.
 *
 * Every message below is a fixed sentence: no driver output, no SQL fragment and
 * no target text is ever copied from an error into a response. An unknown error
 * falls through, so the server's regular 500 handling stays in charge.
 */
export function sendWebScanError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof WebScanNotFoundError) {
    return sendError(reply, 404, 'not_found', 'Not found');
  }
  if (error instanceof WebScanConflictError) {
    return sendError(reply, 409, 'conflict', 'The request conflicts with the current state');
  }
  if (error instanceof WebScanPausedError) {
    return sendError(reply, 409, 'paused', 'The website security scanner is paused');
  }
  if (error instanceof WebScanAuthorizationError) {
    return sendError(reply, 409, 'authorization_required', 'The site is not authorized to be scanned');
  }
  if (error instanceof WebScanScheduleError || error instanceof ScanSettingsError) {
    return sendError(reply, 422, 'invalid_request', error.message);
  }
  return undefined;
}

/** The admin id comes from the guard's session; a missing one is the regular 404. */
export function webScanAdminId(request: FastifyRequest): string | undefined {
  return request.adminUser?.id;
}

/**
 * The regular 404 of the scanner routes.
 *
 * A row that is not there, a row of another site and a caller that is not a platform
 * admin all get the same answer, so the scanner area never reveals what exists.
 */
export function sendWebScanNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'not_found', 'Not found');
}

/**
 * Reads and validates one uuid param (`scanId`, `exceptionId`); a bad id is a
 * request error, not a miss.
 */
export function parseWebScanParam(
  request: { params: unknown },
  reply: FastifyReply,
  field: string,
): string | FastifyReply {
  const raw = (request.params as Record<string, string>)[field];
  const parsed = WebScanIdSchema.safeParse(raw);
  if (!parsed.success) {
    return sendWebScanValidationError(reply, parsed.error);
  }
  return parsed.data;
}

/** The outcome of a guarded store call: its value, or the reply that already answered. */
export type WebScanOutcome<E> = { ok: true; value: E } | { ok: false; reply: FastifyReply };

/**
 * Wraps a store call so its typed errors are mapped and unknown ones rethrown.
 *
 * Every route that calls the store goes through this one helper, so the mapping
 * of a store error onto the admin envelope lives in a single place.
 */
export async function withWebScanErrors<E>(
  reply: FastifyReply,
  call: () => Promise<E>,
): Promise<WebScanOutcome<E>> {
  try {
    return { ok: true, value: await call() };
  } catch (error: unknown) {
    const handled = sendWebScanError(reply, error);
    if (handled !== undefined) return { ok: false, reply: handled };
    throw error;
  }
}
