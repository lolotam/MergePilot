import type { ApiProvider, FallbackSetting } from './types.js';

// The reviewer panel (ADR-0017): up to five review bots per workspace. Slot 1 is the main bot (the
// workspace settings); slots 2-5 are extra bots. Re-exported by types.ts.

/** Preset logo keys; each is an original SVG at `apps/web/public/bots/<key>.svg`. */
export const BOT_LOGOS = [
  'pilot',
  'owl',
  'fox',
  'robot',
  'rocket',
  'shield',
  'bolt',
  'eye',
  'brain',
  'star',
  'leaf',
  'wave',
] as const;
export type BotLogo = (typeof BOT_LOGOS)[number];

export const MAIN_BOT_SLOT = 1;
export const MIN_EXTRA_BOT_SLOT = 2;
export const MAX_EXTRA_BOT_SLOT = 5;
/** Slots 2-5: at most four extra bots next to the main one. */
export const MAX_EXTRA_BOTS = MAX_EXTRA_BOT_SLOT - MIN_EXTRA_BOT_SLOT + 1;
export const MAX_BOT_NAME_LENGTH = 40;
export const DEFAULT_BOT_NAME = 'MergePilot';
export const DEFAULT_BOT_LOGO: BotLogo = 'pilot';

/** `separate`: each bot publishes its own review; `consensus`: one merged review. */
export const PANEL_MODES = ['separate', 'consensus'] as const;
export type PanelMode = (typeof PANEL_MODES)[number];
export const DEFAULT_PANEL_MODE: PanelMode = 'separate';
export const DEFAULT_PANEL_MIN_AGREEMENT = 1;

export function isExtraBotSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= MIN_EXTRA_BOT_SLOT && slot <= MAX_EXTRA_BOT_SLOT;
}

/** Names compare trimmed and case-insensitively (the unique index is on `lower(name)`). */
export function sameBotName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** An extra bot (slots 2-5). Extra bots have no heavy model. */
export interface ReviewerBot {
  slot: number;
  name: string;
  logo: BotLogo;
  active: boolean;
  provider: ApiProvider;
  model: string;
  effort: string | null;
  fallback: FallbackSetting[];
  /** Read-only exploration (ADR-0046); undefined in an upsert keeps it, while reads always set it. */
  exploreEnabled?: boolean | undefined;
  /** The bot's review skill (ADR-0034); null or undefined = Default. Stores leave it out while unset. */
  skillId?: string | null | undefined;
  /**
   * The name of the bot's skill that was deleted (set by deleteReviewSkill); shown on the bot until
   * a skill is chosen again. An upsert with `skillId` undefined keeps both stored fields; with a
   * `skillId` it writes this value (null clears it).
   */
  skillRemovedName?: string | null | undefined;
  /**
   * Migration 0018: this bot's call timeout override in ms. An omitted write keeps the stored
   * value; null resets to the repository's effective timeout (or the engine default).
   * Extra bots do not inherit the main bot's override.
   */
  callTimeoutMs?: number | null | undefined;
}

/** Thrown by AppStore.upsertReviewerBot when another bot of the workspace already has this name. */
export class BotNameTakenError extends Error {
  constructor(name: string) {
    super(`another bot in this workspace is already named "${name}"`);
    this.name = 'BotNameTakenError';
  }
}

/** Thrown for a bot slot outside 2-5 (slot 1 is the main bot, stored in the settings). */
export class InvalidBotSlotError extends Error {
  constructor(slot: number) {
    super(`bot slot ${slot} is not an extra bot slot (2-${MAX_EXTRA_BOT_SLOT})`);
    this.name = 'InvalidBotSlotError';
  }
}

/** The extra-bot part of AppStore. */
export interface ReviewerBotStore {
  /** The workspace's extra bots, sorted by slot. */
  listReviewerBots(workspaceId: string): Promise<ReviewerBot[]>;
  /**
   * Creates or replaces the bot in `bot.slot`. Throws InvalidBotSlotError for a slot outside 2-5,
   * BotNameTakenError when the name (ignoring case) belongs to another extra bot or to the main
   * bot, UnknownSkillError when `skillId` is not a skill of this workspace, and
   * WorkspaceDeletedError when the workspace is gone.
   */
  upsertReviewerBot(workspaceId: string, bot: ReviewerBot): Promise<ReviewerBot>;
  /** Deletes the bot in this slot; returns whether it existed. */
  deleteReviewerBot(workspaceId: string, slot: number): Promise<boolean>;
}
