import { useParams } from 'react-router';
import { useBotsQuery, type BotLogo, type BotsResponse } from '../api/bots.js';
import type { ReviewRun } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { BotLogoIcon, MAIN_BOT_DEFAULT_NAME, sameBotName } from '../settings/bots/BotLogo.js';

/**
 * The logo of the bot that ran a run. Slot 1 is always the main bot. An extra slot's current bot
 * is used only while it still has the run's name (a deleted slot may hold another bot now).
 */
export function runBotLogo(bots: BotsResponse | undefined, slot: number, name: string | null | undefined): BotLogo | undefined {
  if (slot === 1) return bots?.main?.logo;
  const bot = bots?.bots?.find((b) => b.slot === slot);
  return bot && (!name || sameBotName(bot.name, name)) ? bot.logo : undefined;
}

/** Whether a run row shows its bot: an extra bot's run, or a PR whose runs span several bots. */
export function showsRunBot(run: Pick<ReviewRun, 'botSlot'>, runs: ReadonlyArray<Pick<ReviewRun, 'botSlot'>>): boolean {
  return (run.botSlot ?? 1) > 1 || new Set(runs.map((r) => r.botSlot ?? 1)).size > 1;
}

/** A small bot chip (16 px logo and name) under a run's provider and model (ADR-0017). */
export function RunBotChip({ run }: { run: Pick<ReviewRun, 'botSlot' | 'botName'> }) {
  const { t } = useI18n();
  const { workspaceId = '' } = useParams();
  const bots = useBotsQuery(workspaceId).data;
  const name = run.botName ?? MAIN_BOT_DEFAULT_NAME;
  const logo = runBotLogo(bots, run.botSlot ?? 1, run.botName);
  return (
    <span
      data-testid="run-bot-chip"
      title={`${t('runBotLabel')}: ${name}`}
      className="inline-flex items-center gap-1 max-w-[10rem] px-1.5 py-0.5 rounded-full bg-ink-100 dark:bg-ink-800 text-[10.5px] font-semibold text-ink-700 dark:text-ink-300"
    >
      <BotLogoIcon logo={logo} letter={name} size={16} />
      <span className="truncate">{name}</span>
    </span>
  );
}
