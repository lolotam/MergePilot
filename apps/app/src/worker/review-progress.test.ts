import { describe, expect, it, vi } from 'vitest';
import { panelSetup } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';
import { WorkspaceDeletedError } from '../core/types.js';

for (const panelMode of ['separate', 'consensus'] as const) {
  describe(`${panelMode} progress`, () => {
    it('publishes despite an auxiliary progress failure without logging the raw error', async () => {
      const h = await panelSetup({ settings: { panelMode }, bots: [{ slot: 2 }] });
      vi.spyOn(h.deps.store, 'recordReviewProgress').mockRejectedValue(new Error('secret-database-url'));
      const warnings = vi.spyOn(h.deps.logger!, 'warn');
      await processReviewJob(h.job, h.deps);
      expect((await h.runs()).every((run) => run.status === 'completed')).toBe(true);
      expect(h.created.length).toBeGreaterThan(0);
      expect(warnings).toHaveBeenCalled();
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('secret-database-url');
    });

    it('still prevents publication when the progress write reports workspace deletion', async () => {
      const h = await panelSetup({ settings: { panelMode }, bots: [{ slot: 2 }] });
      vi.spyOn(h.deps.store, 'recordReviewProgress').mockRejectedValue(new WorkspaceDeletedError('ws-panel'));
      await processReviewJob(h.job, h.deps);
      expect(h.created).toHaveLength(0);
      expect((await h.runs()).every((run) => run.status === 'skipped')).toBe(true);
    });
    it('completes a fast bot before a slow sibling and retains completion when publication fails', async () => {
      const h = await panelSetup({ settings: { panelMode }, bots: [{ slot: 2 }] });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const original = h.createModelForProvider.getMockImplementation()!;
      h.createModelForProvider.mockImplementation(async (...args) => {
        const model = await original(...args);
        if (args[0].model === 'bot2-model') {
          const generate = model.generate.bind(model);
          model.generate = async (request) => { await blocked; return generate(request); };
        }
        return model;
      });
      let publish!: () => void;
      const pendingPublish = new Promise<void>((resolve) => { publish = resolve; });
      h.client.createReview = async () => { await pendingPublish; throw new Error('publisher offline'); };
      const work = processReviewJob(h.job, h.deps);
      try {
        await vi.waitFor(async () => {
          const runs = await h.runs();
          expect(runs[0]?.reviewProgress?.status).toBe('completed');
          expect(runs[0]?.status).toBe('running');
          expect(runs[1]?.reviewProgress).toBeNull();
          expect(runs[1]?.status).toBe('running');
        });
        release();
        await vi.waitFor(async () => expect((await h.runs())[1]?.reviewProgress?.status).toBe('completed'));
        expect((await h.runs()).every((run) => run.status === 'running')).toBe(true);
      } finally { release(); publish(); await work; }
      const finished = await h.runs();
      expect(finished.every((run) => run.reviewProgress?.status === 'completed')).toBe(true);
      expect(finished.some((run) => run.status === 'failed')).toBe(true);
    });
  });
}
