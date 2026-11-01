import type { FastifyInstance } from 'fastify';
import { requiresAboveDefaultConfirmation, limitsConfirmationDigest } from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import type { WebScanSettingsDto } from '../api/contract-webscan.js';
import {
  WebScanSettingsPatchSchema,
  type WebScanSettingsPatchRequest,
} from '../api/contract-webscan.js';
import type { WebScanStore, WebScanSettingsPatch } from '../webscan/store.js';
import type { WebScanSettings } from '../webscan/types.js';
import {
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
 * The approved-installation list is read-only on this route: ADR-0052 section 8
 * requires every binding to be verified against GitHub before it is saved, and
 * the verifying endpoint arrives with Task 10.
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

    const parsed = WebScanSettingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
    const body = parsed.data;

    if (body.limits !== undefined) {
      // The confirmation is bound to the effective values: the current limits
      // with the submitted fields on top. Nothing is written before it checks.
      const current = await withWebScanErrors(reply, () => store.getSettings());
      if (!current.ok) return current.reply;
      const effective = { ...current.value.limits, ...toStoreLimits(body.limits) };
      const confirmed = !requiresAboveDefaultConfirmation(effective)
        ? true
        : body.limitConfirmation?.digest === limitsConfirmationDigest(effective);
      if (!confirmed) {
        return sendError(
          reply,
          422,
          'confirmation_required',
          'A value above its default needs a confirmation bound to the submitted values',
        );
      }
    }

    const updated = await withWebScanErrors(reply, () =>
      store.updateSettings(adminId, toStoreSettingsPatch(body)),
    );
    if (!updated.ok) return updated.reply;
    return reply.status(200).send(toWebScanSettingsDto(updated.value));
  });
}
