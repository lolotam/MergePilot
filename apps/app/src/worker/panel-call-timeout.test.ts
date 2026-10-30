import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConfig, type MergePilotConfig } from '@mergepilot/engine';
import { buildMarker, type LoadRepoConfigResult } from '@mergepilot/github';
import type { MaxFindingsChoice } from '../core/types.js';
import { effectiveConfigFor } from './effective-config.js';
import { HEAD, panelSetup, PUBLISHER, WS } from './panel.fixtures.js';
import { panelTimeoutKeyOf } from './panel-timeout-key.js';
import { panelBots } from './panel.js';
import { processReviewJob } from './process-review.js';

// The per-bot call timeout override (migration 0018): each bot runs with its own override (the main
// bot from the settings, an extra bot from itself only), and any active bot's override — set,
// changed or reset — moves the marker identity so the next review is never skipped as reviewed.

const CONSENSUS = { panelMode: 'consensus' as const, panelMinAgreement: 1 };
const PURE_SETTINGS = { language: 'en' as const, minSeverity: 'medium' as const, maxFindings: 5 as MaxFindingsChoice };

// The config hash encoding panelBots' callers rely on: a bare identity when all overrides are unset,
// a structured `{ base, callTimeoutMs }` when one is present (main's markers carry no bot suffix).
const MAIN_BASE = JSON.stringify({ provider: 'anthropic', model: 'main-model', language: 'en' });
const BOT2_BASE = JSON.stringify({ provider: 'openai', model: 'bot2-model', language: 'en' });
const hashText = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const withOverride = (base: string, callTimeoutMs: number) => hashText(JSON.stringify({ base, callTimeoutMs }));

const configFromBody = (body: string) => /config=([a-f0-9]{12})/.exec(body)![1]!;

/** The effective config the job actually constructed this model with. */
function modelConfig(h: Awaited<ReturnType<typeof panelSetup>>, model: string): MergePilotConfig {
  const call = h.createModelForProvider.mock.calls.find(([config]) => config.model === model);
  if (!call) throw new Error(`the model ${model} was never constructed`);
  return call[0];
}

const CHOICE = { provider: 'openai' as const, model: 'gpt-x', effort: null };
type RepoConfigResult = Extract<LoadRepoConfigResult, { config: MergePilotConfig }>;

/** What `loadRepoConfig` returns for this file, parsed with the worker's defaults. */
function repoWithCallTimeout(callTimeoutMs: number): RepoConfigResult {
  const text = `review:\n  callTimeoutMs: ${callTimeoutMs}\n`;
  const parsed = parseConfig(text, { defaults: { ...CHOICE, maxFindings: 5 } });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return { configText: text, config: parsed.config, rulesFiles: [], ...(parsed.defaulted ? { defaulted: parsed.defaulted } : {}) };
}

const noFile = (): LoadRepoConfigResult => ({ missing: true });

describe('panelTimeoutKeyOf', () => {
  it('is undefined when no bot has an explicit override (null and omitted inherit)', () => {
    expect(panelTimeoutKeyOf([{ slot: 1 }, { slot: 2, callTimeoutMs: null }, { slot: 3, callTimeoutMs: undefined }])).toBeUndefined();
  });

  it('encodes the overrides structured and stable by slot, regardless of the input order', () => {
    expect(panelTimeoutKeyOf([{ slot: 2, callTimeoutMs: 600_000 }, { slot: 4, callTimeoutMs: 900_000 }]))
      .toBe(JSON.stringify([{ slot: 2, callTimeoutMs: 600_000 }, { slot: 4, callTimeoutMs: 900_000 }]));
    expect(panelTimeoutKeyOf([{ slot: 4, callTimeoutMs: 900_000 }, { slot: 2, callTimeoutMs: 600_000 }]))
      .toBe(JSON.stringify([{ slot: 2, callTimeoutMs: 600_000 }, { slot: 4, callTimeoutMs: 900_000 }]));
  });
});

describe('effectiveConfigFor — the bot override and the consensus panel timeout key', () => {
  const built = (repo: LoadRepoConfigResult, callTimeoutMs?: number | null, panelTimeoutKey?: string) =>
    effectiveConfigFor(repo, CHOICE, [], PURE_SETTINGS, undefined, callTimeoutMs, panelTimeoutKey);

  it('a numeric override wins over the repo value; null and omitted inherit it', () => {
    const repo = repoWithCallTimeout(450_000);
    expect(built(noFile()).config.review.callTimeoutMs).toBe(300_000);
    expect(built(repo, null).config.review.callTimeoutMs).toBe(450_000);
    expect(built(noFile(), 600_000).config.review.callTimeoutMs).toBe(600_000);
    expect(built(repo, 600_000).config.review.callTimeoutMs).toBe(600_000);
  });

  it('preserves the exact legacy hash when every override is unset or null', () => {
    const legacy = built(noFile()).configHash;
    expect(built(noFile(), undefined, undefined).configHash).toBe(legacy);
    expect(built(noFile(), null).configHash).toBe(legacy);
    expect(built(noFile(), null, undefined).configHash).toBe(legacy);
  });

  it('an explicit number is its own identity entry, even equal to the engine default', () => {
    expect(built(noFile(), 300_000).configHash).not.toBe(built(noFile()).configHash);
    expect(built(noFile(), 600_000).configHash).not.toBe(built(noFile(), 900_000).configHash);
  });

  it('the panel timeout key extends the hash without touching the bot config', () => {
    const withKey = built(noFile(), undefined, JSON.stringify([{ slot: 2, callTimeoutMs: 600_000 }]));
    expect(withKey.config.review.callTimeoutMs).toBe(300_000);
    expect(withKey.configHash).not.toBe(built(noFile()).configHash);
    expect(withKey.configHash).not.toBe(built(noFile(), 600_000).configHash);
    expect(withKey.configHash).not.toBe(built(noFile(), undefined, JSON.stringify([{ slot: 2, callTimeoutMs: 900_000 }])).configHash);
  });
});

describe('panelBots — each bot carries its own override, extras never the main bot', () => {
  it('the main bot takes the settings override, the extras their own; inactive ones stay out', () => {
    const bots = panelBots(
      { workspaceId: WS, provider: 'anthropic', model: 'main-model', language: 'en', monthlyBudgetUsd: null, callTimeoutMs: 600_000 },
      [
        { slot: 2, name: 'Owl', logo: 'owl', active: true, provider: 'openai', model: 'bot2-model', effort: null, fallback: [], callTimeoutMs: 900_000 },
        { slot: 3, name: 'Dormant', logo: 'fox', active: false, provider: 'openai', model: 'bot3-model', effort: null, fallback: [], callTimeoutMs: 1_200_000 },
      ],
    );
    expect(bots.map((bot) => [bot.slot, bot.callTimeoutMs])).toEqual([[1, 600_000], [2, 900_000]]);
    // The dormant extra's override is not an input to the panel's identity.
    expect(panelTimeoutKeyOf(bots)).toBe(JSON.stringify([{ slot: 1, callTimeoutMs: 600_000 }, { slot: 2, callTimeoutMs: 900_000 }]));
  });

  it('unset overrides normalize to null (inherit) everywhere', () => {
    const bots = panelBots(
      { workspaceId: WS, provider: 'anthropic', model: 'main-model', language: 'en', monthlyBudgetUsd: null },
      [
        { slot: 2, name: 'Owl', logo: 'owl', active: true, provider: 'openai', model: 'bot2-model', effort: null, fallback: [] },
        { slot: 3, name: 'Dormant', logo: 'fox', active: false, provider: 'openai', model: 'bot3-model', effort: null, fallback: [], callTimeoutMs: 600_000 },
      ],
    );
    expect(bots.map((bot) => [bot.slot, bot.callTimeoutMs])).toEqual([[1, null], [2, null]]);
    expect(panelTimeoutKeyOf(bots)).toBeUndefined();
  });
});

describe('processReviewJob — the per-bot call timeout in the review config', () => {
  it('runs the main bot on 600000 while the extra keeps the repo 450000 timeout', async () => {
    const h = await panelSetup({
      settings: { callTimeoutMs: 600_000 },
      repoFiles: { '.mergepilot.yml': 'review:\n  maxFindings: 5\n  callTimeoutMs: 450000\n' },
      bots: [{ slot: 2 }],
    });
    await processReviewJob(h.job, h.deps);

    expect(modelConfig(h, 'main-model').review.callTimeoutMs).toBe(600_000);
    expect(modelConfig(h, 'bot2-model').review.callTimeoutMs).toBe(450_000);
  });

  it('without a repo timeout the extra keeps the engine default 300000', async () => {
    const h = await panelSetup({ settings: { callTimeoutMs: 600_000 }, bots: [{ slot: 2 }] });
    await processReviewJob(h.job, h.deps);

    expect(modelConfig(h, 'main-model').review.callTimeoutMs).toBe(600_000);
    expect(modelConfig(h, 'bot2-model').review.callTimeoutMs).toBe(300_000);
  });

  it('a heavy-duty main bot keeps its override', async () => {
    const h = await panelSetup({ settings: { heavyModel: 'heavy-model', heavyThresholdLines: 1, callTimeoutMs: 600_000 } });
    await processReviewJob(h.job, h.deps);

    expect(h.calledModels).toEqual(['heavy-model']);
    const config = modelConfig(h, 'heavy-model');
    expect(config.model).toBe('heavy-model');
    expect(config.review.callTimeoutMs).toBe(600_000);
    // The per-bot override does not shorten the overall review timeout.
    expect(config.review.totalTimeoutMs).toBe(1_200_000);
  });
});

describe('processReviewJob — the timeout is part of the separate-mode identity', () => {
  it('each bot is blocked by its own override\'s marker; resetting the main bot\'s overrides only the main', async () => {
    const reviewed = [
      { id: 1, body: buildMarker({ headSha: HEAD, configHash: withOverride(MAIN_BASE, 600_000) }), user: { login: PUBLISHER } },
      { id: 2, body: buildMarker({ headSha: HEAD, configHash: withOverride(BOT2_BASE, 600_000), bot: 2 }), user: { login: PUBLISHER } },
    ];
    // Both markers match their bots' overrides: nothing runs.
    const stable = await panelSetup({ settings: { callTimeoutMs: 600_000 }, bots: [{ slot: 2, callTimeoutMs: 600_000 }], reviews: reviewed });
    await processReviewJob(stable.job, stable.deps);
    expect(stable.calledModels).toEqual([]);

    // The main bot's override resets; the extra keeps its own: only the main bot reviews again.
    const mainReset = await panelSetup({ settings: { callTimeoutMs: null }, bots: [{ slot: 2, callTimeoutMs: 600_000 }], reviews: reviewed });
    await processReviewJob(mainReset.job, mainReset.deps);
    expect(mainReset.calledModels).toEqual(['main-model']);
    expect((await mainReset.runs()).find((run) => run.botSlot === 2)?.detail).toBe('no new changes since the last review');
  });
});

describe('processReviewJob — the timeout is part of the consensus identity', () => {
  it('the shared slot-1 marker moves when an extra bot\'s override resets, so the panel reviews again', async () => {
    const first = await panelSetup({ settings: CONSENSUS, bots: [{ slot: 2, callTimeoutMs: 600_000 }] });
    await processReviewJob(first.job, first.deps);
    const marker = first.created[0]!.body;

    // The same overrides again: covered by the marker, no bot runs.
    const again = await panelSetup({ settings: CONSENSUS, bots: [{ slot: 2, callTimeoutMs: 600_000 }], reviews: [{ id: 9, body: marker, user: { login: PUBLISHER } }] });
    await processReviewJob(again.job, again.deps);
    expect(again.calledModels).toEqual([]);

    // The override reset to null: the marker must have moved.
    const reset = await panelSetup({ settings: CONSENSUS, bots: [{ slot: 2 }], reviews: [{ id: 9, body: marker, user: { login: PUBLISHER } }] });
    await processReviewJob(reset.job, reset.deps);
    expect(reset.calledModels.sort()).toEqual(['bot2-model', 'main-model']);
    expect(modelConfig(reset, 'bot2-model').review.callTimeoutMs).toBe(300_000);
    // Publication still deduplicates by head and bot, independently of the config identity.
    expect(reset.created).toHaveLength(0);
    // An explicitly requested repeat publishes the new identity on the same head.
    await processReviewJob({ ...reset.job, deliveryId: 'del-timeout-forced', force: true }, reset.deps);
    expect(reset.created).toHaveLength(1);
    expect(configFromBody(reset.created[0]!.body)).not.toBe(configFromBody(marker));
  });

  it('an inactive extra\'s override never moves the shared marker', async () => {
    const first = await panelSetup({ settings: CONSENSUS, bots: [{ slot: 2, callTimeoutMs: 600_000 }, { slot: 3, active: false }] });
    await processReviewJob(first.job, first.deps);
    const marker = first.created[0]!.body;

    const again = await panelSetup({
      settings: CONSENSUS,
      bots: [{ slot: 2, callTimeoutMs: 600_000 }, { slot: 3, active: false, callTimeoutMs: 1_200_000 }],
      reviews: [{ id: 9, body: marker, user: { login: PUBLISHER } }],
    });
    await processReviewJob(again.job, again.deps);
    expect(again.calledModels).toEqual([]);
  });
});
