import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMigratedTestDb, hasIntegrationEnv, INTEGRATION_DATABASE_URL } from './test-helper.js';

describe.skipIf(!hasIntegrationEnv)('API-equivalent card rows on real Postgres (ADR-0047)', () => {
  it('selects only the runs the card can count, with the judge tokens and the method switch', async () => {
    const ctx = await createMigratedTestDb(INTEGRATION_DATABASE_URL, { workspaces: ['ws-eq'] });
    try {
      const insert = async (provider: string, result: object) => {
        await ctx.pool.query(
          `INSERT INTO review_runs (id, workspace_id, installation_id, repo_full_name, pull_number, head_sha, status, provider, model, result)
           VALUES ($1, 'ws-eq', 1, 'acme/repo', 1, $2, 'completed', $3, 'm', $4);`,
          [randomUUID(), randomUUID(), provider, JSON.stringify(result)],
        );
      };
      const base = { v: 1, summary: '', highlights: [], findings: [], language: 'en', usage: { inputTokens: 100, outputTokens: 50 } };
      await insert('openai', {
        ...base,
        pricing: { source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 },
        judge: { threshold: 0.3, checked: 1, filtered: [], duplicatesDropped: 0, attempts: [], inputTokens: 40, outputTokens: 10 },
        fallbackFromMethod: 'subscription',
        modelUsedMethod: 'api-key',
      });
      // An API-key provider: counted only because it stored a subscription part, even an unpriced one.
      await insert('openrouter', { ...base, pricing: { source: 'catalog:x', inputPerMTok: 1, outputPerMTok: 1, subscriptionPart: null } });
      // An API-key provider with nothing stored: not read at all.
      await insert('openrouter', { ...base, pricing: { source: 'catalog:x', inputPerMTok: 1, outputPerMTok: 1 } });

      const rows = await ctx.store.listApiEquivalentRuns('ws-eq', ['openai']);

      expect(rows).toHaveLength(2);
      const subscription = rows.find((row) => row.provider === 'openai');
      expect(subscription).toMatchObject({
        judgeUsage: { inputTokens: 40, outputTokens: 10 },
        fallbackFromMethod: 'subscription',
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      const part = rows.find((row) => row.provider === 'openrouter');
      expect(part).toMatchObject({ judgeUsage: null, fallbackFromMethod: null });
      expect((part?.pricing as { subscriptionPart?: unknown }).subscriptionPart).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
