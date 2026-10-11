import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/core/config.js';
import { BullMqReviewQueue } from '../../src/queue/bullmq-queue.js';
import { createServer } from '../../src/server/create-server.js';
import {
  clearRedis,
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  INTEGRATION_REDIS_URL,
} from './test-helper.js';

describe.skipIf(!hasIntegrationEnv)('webhook → queue end to end on real Postgres + Redis', () => {
  it('receives signed pull_request webhook, stores delivery row, enqueues one Redis job, and deduplicates replay', async () => {
    const ctx = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    await clearRedis(INTEGRATION_REDIS_URL);

    const queue = new BullMqReviewQueue({ redisUrl: INTEGRATION_REDIS_URL });

    const webhookSecret = 'test-wh-secret-000';
    const config: AppConfig = {
      baseUrl: 'https://test.mergepilot.com',
      port: 3000,
      databaseUrl: INTEGRATION_DATABASE_URL,
      redisUrl: INTEGRATION_REDIS_URL,
      masterKey: randomBytes(32).toString('base64'),
      github: {
        appId: '12345',
        privateKey: 'fake-private-key-000',
        webhookSecret,
        clientId: 'fake-client-id-000',
        clientSecret: 'fake-client-secret-000',
      },
      google: { clientId: 'fake-google-id', clientSecret: 'fake-google-secret' },
      authSecret: 'fake-auth-secret-1234567890123456',
    };

    const app = createServer({ config, store: ctx.store, queue, log: false });

    try {
      // Seed a linked installation
      await ctx.store.upsertInstallation({
        id: 12345,
        workspaceId: 'ws-webhook-e2e',
        accountLogin: 'test-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const deliveryId = 'del-e2e-webhook-100';
      const payloadObj = {
        action: 'opened',
        installation: { id: 12345 },
        repository: { full_name: 'test-org/repo-e2e' },
        pull_request: {
          number: 42,
          draft: false,
          head: { sha: 'sha-head-e2e-1' },
          base: { sha: 'sha-base-e2e-2' },
        },
      };
      const payloadStr = JSON.stringify(payloadObj);
      const signature = `sha256=${createHmac('sha256', webhookSecret).update(payloadStr).digest('hex')}`;

      // 1. First POST: valid signed webhook
      const res1 = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': signature,
        },
        payload: payloadStr,
      });

      expect(res1.statusCode).toBe(202);
      const res1Body = JSON.parse(res1.body);
      expect(res1Body.status).toBe('enqueued');
      expect(res1Body.job.deliveryId).toBe(deliveryId);

      // 2. Delivery row stored in real Postgres
      const deliveryRes = await ctx.pool.query<{ delivery_id: string; event: string }>(
        'SELECT delivery_id, event FROM webhook_deliveries WHERE delivery_id = $1;',
        [deliveryId],
      );
      expect(deliveryRes.rows).toHaveLength(1);
      expect(deliveryRes.rows[0].event).toBe('pull_request');

      // 3. Exactly one job enqueued in real Redis
      const redisJob = await queue.queue.getJob(deliveryId);
      expect(redisJob).not.toBeNull();
      expect(redisJob?.data.pullNumber).toBe(42);
      expect(redisJob?.data.installationId).toBe(12345);
      expect(redisJob?.data.deliveryId).toBe(deliveryId);

      // 4. Replay the same webhook delivery
      const res2 = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': signature,
        },
        payload: payloadStr,
      });

      expect(res2.statusCode).toBe(202);
      expect(JSON.parse(res2.body)).toEqual({ status: 'duplicate' });

      // 5. No second job in Redis
      const jobs = await queue.queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
      expect(jobs).toHaveLength(1);
    } finally {
      await app.close();
      await queue.close();
      await ctx.close();
      await clearRedis(INTEGRATION_REDIS_URL);
    }
  });
});
