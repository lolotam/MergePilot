import type { FastifyInstance } from 'fastify';
import {
  requiresAboveDefaultConfirmation,
  limitsAboveDefault,
  limitsConfirmationDigest,
} from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import type { WebScanSettingsDto } from '../api/contract-webscan.js';
import {
  WebScanSettingsPatchSchema,
  type WebScanSettingsPatchRequest,
} from '../api/contract-webscan.js';
import type { WebScanStore, WebScanSettingsPatch } from '../webscan/store.js';
import type { WebScanSettings } from '../webscan/types.js';
import {
  sendWebScanConfirmationRequired,
  sendWebScanValidationError,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';
import { definedFields, toStoreLimits } from './webscan-params.js';

/**
 * The global settings routes of the scanner (ADR-0052 section 5).
 *
 * The store enforces the row lock and the audit trail; the bounds and the
 * above-default confirmation are enforced here, before anything is written, so
 * a rejected change leaves neither a settings change nor an audit row behind.
 *
 * The approved-installation list is not written on this route: ADR-0052 section 8
 * requires every binding to be verified against GitHub before it is saved, so it
 * has its own endpoints (`POST` and `DELETE
 * /api/admin/web-scan/settings/approved-installations`), which verify the
 * installation with GitHub before they write anything. A body that carries
 * `approvedInstallations` is refused here as an unknown key.
 */

/** Builds the response from named fields; a store object is never spread. */
export function toWebScanSettingsDto(settings: WebScanSettings): WebScanSettingsDto {
  return {
    paused: settings.paused,
    alertsEnabled: settings.alertsEnabled,
    limits: {
      maxRequests: settings.limits.maxRequests,
      maxPages: settings.limits.maxPages,
      maxActiveLinks: settings.limits.maxActiveLinks,
      requestsPerSecond: settings.limits.requestsPerSecond,
      requestTimeoutMs: settings.limits.requestTimeoutMs,
      maxResponseBytes: settings.limits.maxResponseBytes,
      totalTimeoutMs: settings.limits.totalTimeoutMs,
    },
    checks: {
      headers: settings.checks.headers,
      cookies: settings.checks.cookies,
      transport: settings.checks.transport,
      disclosure: settings.checks.disclosure,
      files: settings.checks.files,
      active: settings.checks.active,
    },
    defaultSchedule: { ...settings.defaultSchedule },
    retentionDays: settings.retentionDays,
    contact: settings.contact,
    alertMinSeverity: settings.alertMinSeverity,
    alertMinValidation: settings.alertMinValidation,
    approvedInstallations: settings.approvedInstallations.map((entry) => ({ ...entry })),
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
  };
}

/** Builds the store patch; the confirmation field is contract-only and never stored. */
export function toStoreSettingsPatch(body: WebScanSettingsPatchRequest): WebScanSettingsPatch {
  return definedFields({
    paused: body.paused,
    alertsEnabled: body.alertsEnabled,
    limits: body.limits === undefined ? undefined : toStoreLimits(body.limits),
    checks: body.checks,
    defaultSchedule:
      body.defaultSchedule === undefined ? undefined : definedFields(body.defaultSchedule),
    retentionDays: body.retentionDays,
    contact: body.contact,
    alertMinSeverity: body.alertMinSeverity,
    alertMinValidation: body.alertMinValidation,
  });
}

export function registerWebScanSettingsRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  store: WebScanStore,
): void {
  app.get('/api/admin/web-scan/settings', { preHandler: [guard] }, async (request, reply) => {
    if (webScanAdminId(request) === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const settings = await withWebScanErrors(reply, () => store.getSettings());
    if (!settings.ok) return settings.reply;
    return reply.status(200).send(toWebScanSettingsDto(settings.value));
  });

  app.patch('/api/admin/web-scan/settings', { preHandler: [guard] }, async (request, reply) => {
    const adminId = webScanAdminId(request);
    if (adminId === undefined) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }

    // A missing body is a request error: an empty patch would write a change and an
    // audit row for a request that asked for nothing.
    const parsed = WebScanSettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
    const body = parsed.data;

    // The snapshot the change is computed from. The confirmation is bound to it, and
    // the store refuses the change when the row moved in between: two changes that
    // were computed from the same snapshot can never be merged into a combination
    // that no confirmation covered.
    const current = await withWebScanErrors(reply, () => store.getSettings());
    if (!current.ok) return current.reply;

    if (body.limits !== undefined) {
      // The confirmation is bound to the effective values: the current limits
      // with the submitted fields on top. Nothing is written before it checks.
      const effective = { ...current.value.limits, ...toStoreLimits(body.limits) };
      const confirmed = !requiresAboveDefaultConfirmation(effective)
        ? true
        : body.limitConfirmation?.digest === limitsConfirmationDigest(effective);
      if (!confirmed) {
        // The dashboard cannot compute the digest itself, so the answer carries
        // it: the digest of the effective limits and the fields above their
        // default. The administrator confirms, and the same patch is re-sent
        // with that digest.
        return sendWebScanConfirmationRequired(
          reply,
          limitsConfirmationDigest(effective),
          limitsAboveDefault(effective),
        );
      }
    }

    const updated = await withWebScanErrors(reply, () =>
      store.updateSettings(adminId, {
        ...toStoreSettingsPatch(body),
        expectedUpdatedAt: current.value.updatedAt,
      }),
    );
    if (!updated.ok) return updated.reply;
    return reply.status(200).send(toWebScanSettingsDto(updated.value));
  });
}
