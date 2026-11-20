import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMarker } from '@mergepilot/github';
import { finding, HEAD, panelSetup, PUBLISHER, WS } from './panel.fixtures.js';
import { panelBots } from './panel.js';
import { processReviewJob } from './process-review.js';

// Migration 0021: the main bot's switch, the master switch, and the slot-1 couplings when main is off.

const reviewSlot = (body: string) => /<!-- mergepilot:review [^>]*\bbot=(\d+) -->/.exec(body)?.[1];
const hashOf = (provider: string, model: string) =>
  createHash('sha256').update(JSON.stringify({ provider, model, language: 'en' })).digest('hex').slice(0, 12);

describe('panelBots — the main bot is optional', () => {
  const settings = { workspaceId: 'ws', provider: 'anthropic' as const, model: 'main-model', language: 'en' as const, monthlyBudgetUsd: null };
  const extra = (slot: number, active: boolean) => ({
    slot, name: `Bot ${slot}`, logo: 'owl' as const, active, provider: 'openai' as const, model: `bot${slot}-model`, effort: null, fallback: [],
  });

  it('with main off it runs only the active extras, in slot order', () => {
    expect(panelBots({ ...settings, mainBotActive: false }, [extra(3, true), extra(2, true), extra(4, false)]).map((b) => b.slot))
      .toEqual([2, 3]);
  });

  it('with main on it keeps the unchanged main-then-extras order', () => {
    expect(panelBots({ ...settings, mainBotActive: true }, [extra(3, true), extra(2, true)]).map((b) => b.slot))
      .toEqual([1, 2, 3]);
  });
});

describe('processReviewJob — the on/off switches', () => {
  it('main off with a lone extra publishes as bot 2 with that bot\'s identity', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false, provider: 'openrouter', model: 'unused-main-model' },
      bots: [{ slot: 2 }],
      findings: { 'bot2-model': [finding('Owl issue')] },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.calledModels).toEqual(['bot2-model']);
    expect((await h.runs()).map((r) => [r.botSlot, r.status])).toEqual([[2, 'completed']]);
    expect(h.created).toHaveLength(1);
    const body = h.created[0]!.body;
    expect(reviewSlot(body)).toBe('2');
    expect(body).toContain('**Bot 2**');
    expect(body).toContain('openai:bot2-model');
    expect(h.created[0]!.comments?.[0]?.body).toContain('Owl issue');
    expect(body).not.toContain('unused-main-model');
  });

  it('main off in consensus mode publishes one review as the first completed extra', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false, panelMode: 'consensus', panelMinAgreement: 1 },
      bots: [{ slot: 2 }, { slot: 3, name: 'Fox', logo: 'fox', provider: 'gemini', model: 'g-model' }],
      findings: { 'bot2-model': [finding('Owl issue')], 'g-model': [finding('Fox issue')] },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.calledModels.sort()).toEqual(['bot2-model', 'g-model']);
    expect((await h.runs()).map((r) => r.botSlot)).toEqual([2, 3]);
    expect(h.created).toHaveLength(1);
    expect(reviewSlot(h.created[0]!.body)).toBe('2');
  });

  it('main off in consensus skips the rest when the publishing extra\'s run is held elsewhere', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false, panelMode: 'consensus', panelMinAgreement: 1 },
      bots: [{ slot: 2 }, { slot: 3, name: 'Fox', logo: 'fox', provider: 'gemini', model: 'g-model' }],
      findings: { 'bot2-model': [finding('Owl issue')], 'g-model': [finding('Fox issue')] },
    });
    await h.store.createReviewRun({
      workspaceId: WS, jobId: 'other-job', installationId: h.job.installationId, repoFullName: h.job.repoFullName,
      pullNumber: h.job.pullNumber, headSha: h.job.headSha, status: 'running', costUsd: null, detail: null,
      botSlot: 2, botName: 'Bot 2',
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'duplicate' });
    expect(h.calledModels).toEqual([]);
    expect(h.created).toEqual([]);
    expect((await h.runs()).filter((r) => r.jobId === h.job.deliveryId).map((r) => [r.botSlot, r.status, r.detail]))
      .toEqual([[3, 'skipped', 'duplicate']]);
  });

  it('main off in consensus keeps the publisher slot when that extra fails and another completes', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false, panelMode: 'consensus', panelMinAgreement: 1 },
      bots: [{ slot: 2 }, { slot: 3, name: 'Fox', logo: 'fox', provider: 'gemini', model: 'g-model' }],
      failing: ['bot2-model'],
      findings: { 'g-model': [finding('Fox issue')] },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('failed');
    expect(h.created).toHaveLength(1);
    const body = h.created[0]!.body;
    expect(reviewSlot(body)).toBe('2');
    expect(body).toContain('Bot 2');
    expect(body).toContain('did not complete');
    expect((await h.runs()).map((r) => [r.botSlot, r.status])).toEqual([[2, 'failed'], [3, 'completed']]);
  });

  it('main off uses the publishing extra\'s marker as the incremental base', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false },
      bots: [{ slot: 2 }],
      reviews: [{
        id: 5,
        body: buildMarker({ headSha: HEAD, configHash: hashOf('openai', 'bot2-model'), bot: 2 }),
        user: { login: PUBLISHER },
      }],
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.detail).toBe('no new changes since the last review');
    expect(h.calledModels).toEqual([]);
    expect(h.created).toEqual([]);
    expect((await h.runs())[0]).toMatchObject({ botSlot: 2, status: 'skipped', detail: 'no new changes since the last review' });
  });

  it('main on keeps the main bot in the panel and its result leads the job', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }], findings: { 'main-model': [finding('Main issue')] } });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.calledModels.sort()).toEqual(['bot2-model', 'main-model']);
    expect((await h.runs()).map((r) => r.botSlot)).toEqual([1, 2]);
  });

  it('main off ignores another job\'s main run instead of treating it as a duplicate', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false, panelMode: 'consensus', panelMinAgreement: 1 },
      bots: [{ slot: 2 }, { slot: 3, name: 'Fox', logo: 'fox', provider: 'gemini', model: 'g-model' }],
      findings: { 'bot2-model': [finding('Owl issue')], 'g-model': [finding('Fox issue')] },
    });
    await h.store.createReviewRun({
      workspaceId: WS, jobId: 'other-job', installationId: h.job.installationId, repoFullName: h.job.repoFullName,
      pullNumber: h.job.pullNumber, headSha: h.job.headSha, status: 'running', costUsd: null, detail: null,
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.calledModels.sort()).toEqual(['bot2-model', 'g-model']);
    expect(reviewSlot(h.created[0]!.body)).toBe('2');
    expect((await h.runs()).filter((r) => r.jobId === h.job.deliveryId).map((r) => r.botSlot)).toEqual([2, 3]);
  });

  it('master off skips before a run, a GitHub call or a PR write — even for an explicit review', async () => {
    const h = await panelSetup({ settings: { botsEnabled: false, mainBotActive: true }, bots: [{ slot: 2, active: true }] });
    h.job.force = true;
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'bots are off' });
    expect(await h.runs()).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.deps.githubAppFactory).not.toHaveBeenCalled();
    expect(h.events('job.skipped')[0]).toMatchObject({ reason: 'bots-off' });
    // The master switch changes nothing saved: turning it back on restores the same panel.
    expect(await h.store.getSettings(WS)).toMatchObject({ botsEnabled: false, mainBotActive: true });
    expect((await h.store.listReviewerBots(WS)).map((b) => [b.slot, b.active])).toEqual([[2, true]]);
  });

  it('main off with every extra off skips with no run row and no PR write — even for an explicit review', async () => {
    const h = await panelSetup({ settings: { mainBotActive: false, botsEnabled: true }, bots: [{ slot: 2, active: false }] });
    h.job.force = true;
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'all bots are off' });
    expect(await h.runs()).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.deps.githubAppFactory).not.toHaveBeenCalled();
    expect(h.events('job.skipped')[0]).toMatchObject({ reason: 'all-bots-off' });
    expect((await h.store.listReviewerBots(WS)).map((b) => [b.slot, b.active])).toEqual([[2, false]]);
  });

  it('a forced job with only a no-key extra skips with `no key` and logs the skip', async () => {
    const h = await panelSetup({ settings: { mainBotActive: false }, bots: [{ slot: 2 }], noKey: ['openai'] });
    h.job.force = true;
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'no key' });
    expect((await h.runs()).map((r) => [r.botSlot, r.status, r.detail])).toEqual([[2, 'skipped', 'no key']]);
    expect(h.created).toEqual([]);
    expect(h.events('job.skipped')[0]).toMatchObject({ reason: 'no key' });
  });

  it('main off publishes the monthly-budget notice as the extra publisher', async () => {
    const h = await panelSetup({
      settings: { mainBotActive: false, monthlyBudgetUsd: 1 }, bots: [{ slot: 2 }], monthlyCost: 2,
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'monthly budget reached' });
    expect((await h.runs()).map((r) => [r.botSlot, r.status, r.detail])).toEqual([[2, 'skipped', 'monthly budget reached']]);
    expect(h.created).toHaveLength(1);
    expect(reviewSlot(h.created[0]!.body)).toBe('2');
    expect(h.created[0]!.body).toContain('monthly budget reached');
  });

  it('master off skips an automatic review before a run, a GitHub call or a PR write', async () => {
    const h = await panelSetup({ settings: { botsEnabled: false, mainBotActive: true }, bots: [{ slot: 2, active: true }] });
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'bots are off' });
    expect(await h.runs()).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.deps.githubAppFactory).not.toHaveBeenCalled();
    expect(h.events('job.skipped')[0]).toMatchObject({ reason: 'bots-off' });
  });
});
