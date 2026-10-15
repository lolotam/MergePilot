import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getOrgAdapter } from 'better-auth/plugins/organization';
import { requireRole } from '../auth/guard.js';
import { BotNameTakenError, InvalidBotSlotError, WorkspaceDeletedError } from '../core/types.js';
import { buildBackupFile } from './backup-export.js';
import { planRestore, RestoreProblem } from './backup-restore.js';
import {
  BACKUP_MAX_BYTES,
  ExportBackupBodySchema,
  MIN_PASSPHRASE_LENGTH,
  RestoreBackupBodySchema,
  type BackupPreview,
} from './contract-backup.js';
import { sendError } from './helpers.js';
import { invalidateModelsCache } from './provider-routes.js';
import type { DashboardApiDeps } from './routes.js';

/** Like sendError, plus the file field a restore was refused for. */
function sendFieldError(reply: FastifyReply, status: number, code: string, message: string, field?: string): FastifyReply {
  return reply.status(status).send({ error: { code, message, ...(field ? { field } : {}) } });
}

/** A request over the 1 MB cap answers 413 in the dashboard's error shape. */
function tooLargeHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
    return sendError(reply, 413, 'file_too_large', 'The backup file is larger than 1 MB');
  }
  throw error;
}

/**
 * Settings backup and restore (ADR-0018). Owner only. The export decrypts each key with the
 * workspace vault and seals it with the owner's passphrase on the server; the restore target is the
 * URL's workspace, never anything in the file. Neither the passphrase nor a key is ever logged.
 */
export function registerBackupRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  app.post(
    '/api/workspaces/:workspaceId/backup/export',
    { preHandler: [requireRole('owner', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = ExportBackupBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid export request');
      }
      const { includeKeys, passphrase } = parsed.data;
      if (includeKeys && !passphrase) {
        return sendError(reply, 400, 'passphrase_required', 'A passphrase is required to include the API keys');
      }
      if (includeKeys && passphrase && passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return sendError(reply, 400, 'passphrase_too_short', `The passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters`);
      }

      const orgAdapter = getOrgAdapter((await deps.auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0]);
      const org = await orgAdapter.findOrganizationById(workspaceId);
      if (!org) return sendError(reply, 404, 'not_found', 'Workspace not found');

      const { file, filename, counts } = await buildBackupFile(
        deps,
        { id: workspaceId, name: org.name, slug: org.slug ?? workspaceId },
        { includeKeys, passphrase, now: deps.now ? deps.now() : new Date() },
      );
      request.log.info({ event: 'backup.export', workspaceId, includeKeys, ...counts }, 'Settings backup exported');
      return reply
        .status(200)
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store')
        .send(JSON.stringify(file, null, 2));
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/backup/restore',
    { preHandler: [requireRole('owner', deps.auth)], bodyLimit: BACKUP_MAX_BYTES, errorHandler: tooLargeHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = RestoreBackupBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid restore request');
      }
      const body = parsed.data;
      const dryRun = body.dryRun ?? false;

      let plan;
      try {
        plan = await planRestore(deps, {
          workspaceId,
          userId: request.auth?.userId ?? '',
          file: body.file,
          passphrase: body.passphrase,
          sections: body.sections,
        });
      } catch (err) {
        if (err instanceof RestoreProblem) return sendFieldError(reply, err.status, err.code, err.message, err.field);
        throw err;
      }
      const preview: BackupPreview = { dryRun, ...plan.preview };
      if (dryRun) return reply.status(200).send(preview);

      try {
        await deps.store.restoreWorkspace(workspaceId, plan.restore);
      } catch (err) {
        if (err instanceof BotNameTakenError) {
          return sendError(reply, 409, 'bot_name_taken', 'Another bot in this workspace already has this name');
        }
        if (err instanceof InvalidBotSlotError) return sendError(reply, 400, 'invalid_slot', 'Each extra bot needs its own slot 2-5');
        if (err instanceof WorkspaceDeletedError) return sendError(reply, 404, 'not_found', 'Workspace not found');
        throw err;
      }
      for (const c of plan.restore.credentials ?? []) invalidateModelsCache(workspaceId, c.provider);
      for (const entry of plan.restore.dualProviderKeyChanges ?? []) invalidateModelsCache(workspaceId, entry.provider);
      request.log.info(
        {
          event: 'backup.restore',
          workspaceId,
          sections: preview.sections,
          settingsChanged: preview.settingsChanged,
          bots: preview.bots,
          credentials: preview.credentials.length,
        },
        'Settings backup restored',
      );
      return reply.status(200).send(preview);
    },
  );
}
