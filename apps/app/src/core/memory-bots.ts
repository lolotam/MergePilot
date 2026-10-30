import {
  BotNameTakenError,
  DEFAULT_BOT_LOGO,
  DEFAULT_BOT_NAME,
  DEFAULT_PANEL_MIN_AGREEMENT,
  DEFAULT_PANEL_MODE,
  InvalidBotSlotError,
  isExtraBotSlot,
  sameBotName,
  type ReviewerBot,
} from './bot-types.js';
import { withSetSkillFields } from './memory-skills.js';
import type { WorkspaceSettings } from './types.js';

// In-memory twins of pg-bots.ts (the reviewer panel's extra bots, ADR-0017).

/** Extra bots keyed by workspace id, a NUL separator and the slot. */
export type MemoryBots = Map<string, ReviewerBot>;

const key = (workspaceId: string, slot: number) => `${workspaceId}\u0000${slot}`;
const copy = (bot: ReviewerBot): ReviewerBot => withSetSkillFields({
  ...bot,
  exploreEnabled: bot.exploreEnabled ?? false,
  fallback: bot.fallback.map((f) => ({ ...f })),
  callTimeoutMs: bot.callTimeoutMs ?? null,
});

export function listMemoryBots(bots: MemoryBots, workspaceId: string): ReviewerBot[] {
  return [...bots.entries()]
    .filter(([k]) => k.startsWith(`${workspaceId}\u0000`))
    .map(([, bot]) => copy(bot))
    .sort((a, b) => a.slot - b.slot);
}

/** `mainBotName` is the stored main bot name (undefined = no settings yet: the default name). */
export function upsertMemoryBot(
  bots: MemoryBots,
  workspaceId: string,
  bot: ReviewerBot,
  mainBotName: string | undefined,
): ReviewerBot {
  if (!isExtraBotSlot(bot.slot)) throw new InvalidBotSlotError(bot.slot);
  const taken =
    sameBotName(bot.name, mainBotName ?? DEFAULT_BOT_NAME) ||
    listMemoryBots(bots, workspaceId).some((other) => other.slot !== bot.slot && sameBotName(other.name, bot.name));
  if (taken) throw new BotNameTakenError(bot.name);
  bots.set(key(workspaceId, bot.slot), copy(bot));
  return copy(bot);
}

export function deleteMemoryBot(bots: MemoryBots, workspaceId: string, slot: number): boolean {
  return bots.delete(key(workspaceId, slot));
}

export function deleteMemoryWorkspaceBots(bots: MemoryBots, workspaceId: string): void {
  for (const bot of listMemoryBots(bots, workspaceId)) bots.delete(key(workspaceId, bot.slot));
}

type PanelSettings = Pick<WorkspaceSettings, 'botName' | 'botLogo' | 'panelMode' | 'panelMinAgreement'>;

/** The main bot and panel fields as stores read them back: unset fields get the defaults. */
export function panelSettingsOrDefaults(s: PanelSettings): Required<{ [K in keyof PanelSettings]-?: NonNullable<PanelSettings[K]> }> {
  return {
    botName: s.botName ?? DEFAULT_BOT_NAME,
    botLogo: s.botLogo ?? DEFAULT_BOT_LOGO,
    panelMode: s.panelMode ?? DEFAULT_PANEL_MODE,
    panelMinAgreement: s.panelMinAgreement ?? DEFAULT_PANEL_MIN_AGREEMENT,
  };
}

/** A save: fields left undefined keep the stored value. */
export function keepPanelSettings(next: PanelSettings, stored: PanelSettings | undefined): PanelSettings {
  return {
    botName: next.botName ?? stored?.botName,
    botLogo: next.botLogo ?? stored?.botLogo,
    panelMode: next.panelMode ?? stored?.panelMode,
    panelMinAgreement: next.panelMinAgreement ?? stored?.panelMinAgreement,
  };
}
