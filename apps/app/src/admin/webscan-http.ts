import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ScanSettingsError } from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import {
  WebScanIdSchema,
  type WebScanConfirmationRequiredBody,
  type WebScanLimitField,
  type WebScanLimits,
} from '../api/contract-webscan.js';
import type { WebScanTargetRefusedBody } from '../api/contract-webscan-target.js';
import { WebScanScheduleError } from '../webscan/schedule.js';
import {
  WebScanAuthorizationError,
  WebScanConflictError,
  WebScanNotFoundError,
  WebScanPausedError,
} from '../webscan/store.js';
import type { WebScanTargetRefusalReason } from '../webscan/github-target-reasons.js';

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
 * Answers 422 with the confirmation the administrator still has to give.
 *
 * The dashboard runs in a browser and cannot compute the digest of the
 * effective limits itself, so the server hands it back: the digest of the
 * effective submitted limits and the names of the limit fields that are above
 * their default. The administrator confirms those fields, and the dashboard
 * re-sends the same patch with `limitConfirmation: { digest }`.
 *
 * The effective limits travel with the refusal: they are the values the
 * digest was computed from, so the dashboard shows exactly what the server is
 * about to store, even when the row moved since the dashboard read it.
 *
 * The digest and the field names are not secrets; the message names no value.
 */
export function sendWebScanConfirmationRequired(
  reply: FastifyReply,
  digest: string,
  fieldsAboveDefault: readonly WebScanLimitField[],
  effectiveLimits: WebScanLimits,
): FastifyReply {
  const body: WebScanConfirmationRequiredBody = {
    error: {
      code: 'confirmation_required',
      message: 'A value above its default needs a confirmation bound to the submitted values',
      digest,
      fieldsAboveDefault: [...fieldsAboveDefault],
      effectiveLimits: { ...effectiveLimits },
    },
  };
  return reply.status(422).send(body);
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

/**
 * The fixed message of every refusal of a GitHub target.
 *
 * The message names the reason and nothing else: no value of GitHub, no error
 * body, no credential and no repository name.
 */
const TARGET_REFUSAL_MESSAGES: Record<WebScanTargetRefusalReason, string> = {
  no_github_account: 'The administrator has no linked GitHub account',
  installation_not_accessible: 'The installation is not accessible to the administrator',
  installation_suspended: 'The installation is suspended',
  missing_issues_permission: 'The installation does not grant the issues permission',
  account_mismatch: 'The repository does not belong to the approved account',
  repository_not_found: 'The repository does not exist for this installation',
  not_private: 'The repository is not private',
  no_user_access: 'The administrator cannot reach the repository through the installation',
  installation_lost: 'The installation is gone',
  repository_not_approved: 'No approved installation of the administrator owns the repository',
  approval_missing: 'The approval of the installation is gone',
  admin_not_authorized: 'The administrator is no longer a platform administrator',
  github_unavailable: 'GitHub is not available',
  unverifiable: 'The target could not be verified',
  not_site_owner: 'Only the owner of the site can bind its repository',
};

/**
 * Answers 422 with the bounded reason a target was refused.
 *
 * A refusal is never a 500 and never a guess: the answer carries the reason
 * code of the verification and a fixed sentence beside it.
 */
export function sendWebScanTargetRefused(
  reply: FastifyReply,
  reason: WebScanTargetRefusalReason,
): FastifyReply {
  const body: WebScanTargetRefusedBody = {
    error: { code: 'target_refused', reason, message: TARGET_REFUSAL_MESSAGES[reason] },
  };
  return reply.status(422).send(body);
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
