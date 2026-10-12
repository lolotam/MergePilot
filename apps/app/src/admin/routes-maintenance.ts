import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../api/helpers.js';
import type { MaintenanceRunDto } from '../api/contract.js';
import type { AppStore, MaintenanceRun } from '../core/types.js';
import { startRetention } from '../worker/retention.js';

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;

function toDto(run: MaintenanceRun | null): MaintenanceRunDto | null {
  if (!run) return null;
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    deletedCount: run.deletedCount,
    error: run.error,
  };
}

/**
 * Operator view of the run retention job (ADR-0014): the last run, and "run now". The cleanup
 * runs in this process after the reply; the same store lease as the daily job prevents overlap.
 */
export function registerMaintenanceRoutes(app: FastifyInstance, guard: Guard, store: AppStore | undefined): void {
  app.get('/api/admin/maintenance', { preHandler: [guard] }, async (_request, reply) => {
    const lastRun = store ? await store.getLatestMaintenanceRun('retention') : null;
    return reply.status(200).send({ retention: { lastRun: toDto(lastRun) } });
  });

  app.post('/api/admin/maintenance/run-retention', { preHandler: [guard] }, async (request, reply) => {
    if (!store) return sendError(reply, 503, 'unavailable', 'Maintenance is not available');
    const lease = await startRetention(store, { logger: request.log });
    if (!lease) {
      return sendError(reply, 409, 'already_running', 'A retention cleanup is already running');
    }
    request.log.info({ event: 'maintenance.retention_requested', runId: lease.run.id }, 'Run retention started by an admin');
    void lease.execute().catch((err: unknown) => {
      request.log.error(
        { event: 'maintenance.retention_failed', errorName: err instanceof Error ? err.name : 'unknown' },
        'Run retention failed',
      );
    });
    return reply.status(202).send({ runId: lease.run.id });
  });
}
