import { useBotsQuery } from '../../api/bots.js';
import { useI18n } from '../../i18n/context.js';
import { MAIN_BOT_DEFAULT_NAME } from '../bots/BotLogo.js';

/** Names the bot in each slot (1 = main bot) for a skill's "used by" list. */
export function useBotNames(workspaceId: string): (slots: readonly number[]) => string[] {
  const { t } = useI18n();
  const bots = useBotsQuery(workspaceId).data;
  return (slots) =>
    [...slots]
      .sort((a, b) => a - b)
      .map((slot) =>
        slot === 1
          ? (bots?.main?.name ?? MAIN_BOT_DEFAULT_NAME)
          : (bots?.bots?.find((b) => b.slot === slot)?.name ?? t('skillsBotSlot', { slot })),
      );
}
