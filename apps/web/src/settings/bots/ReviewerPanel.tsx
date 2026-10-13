import { useState } from 'react';
import type { Settings } from '@mergepilot/app/contract';
import { useBotsQuery, useSaveBotMutation, type BotsResponse, type ReviewerBotInput } from '../../api/bots.js';
import type { ApiProvider } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { ReviewSettingsCard } from '../ReviewSettingsCard.js';
import {
  BOT_LOGO_KEYS,
  EXTRA_BOT_SLOTS,
  MAIN_BOT_DEFAULT_LOGO,
  MAIN_BOT_DEFAULT_NAME,
  MAX_BOTS,
  sameBotName,
} from './BotLogo.js';
import { BOT_PANEL_ID, BotTabs, botTabId, type BotTab } from './BotTabs.js';
import { ExtraBotCard, type MainBotModel } from './ExtraBotCard.js';
import { PanelOutputCard } from './PanelOutputCard.js';

export interface ReviewerPanelProps {
  workspaceId: string;
  settings: Settings | null | undefined;
  isLoading: boolean;
  isMember: boolean;
  onSave: (settings: Settings) => Promise<void>;
  isSaving: boolean;
  /** Providers with a saved key; undefined = unknown (members). */
  keyedProviders?: readonly ApiProvider[] | undefined;
}

type MainBot = BotTab & MainBotModel;

/** The main bot: the saved settings when loaded (fresher after a save), else the bots answer. */
function mainBotOf(settings: Settings | null | undefined, bots: BotsResponse | undefined): MainBot {
  if (settings) {
    return {
      slot: 1,
      name: settings.botName ?? MAIN_BOT_DEFAULT_NAME,
      logo: settings.botLogo ?? MAIN_BOT_DEFAULT_LOGO,
      active: true,
      provider: settings.provider,
      model: settings.model,
      effort: settings.effort ?? null,
      fallback: settings.fallback ?? [],
    };
  }
  const main = bots?.main;
  return {
    slot: 1,
    name: main?.name ?? MAIN_BOT_DEFAULT_NAME,
    logo: main?.logo ?? MAIN_BOT_DEFAULT_LOGO,
    active: true,
    provider: main?.provider ?? null,
    model: main?.model ?? null,
    effort: main?.effort ?? null,
    fallback: main?.fallback ?? [],
  };
}

/**
 * A new bot in the first free slot (2-5): «Bot N» (the next free number), the first unused logo,
 * the main bot's model, and inactive until it is configured and switched on.
 */
export function newBotInput(main: MainBot, existing: readonly BotTab[]): { slot: number; input: ReviewerBotInput } | null {
  const slot = EXTRA_BOT_SLOTS.find((s) => !existing.some((b) => b.slot === s));
  if (slot === undefined || !main.provider || !main.model) return null;
  const all = [main, ...existing];
  let n = slot;
  while (all.some((b) => sameBotName(b.name, `Bot ${n}`))) n += 1;
  const used = new Set(all.map((b) => b.logo));
  return {
    slot,
    input: {
      name: `Bot ${n}`,
      logo: BOT_LOGO_KEYS.find((key) => !used.has(key)) ?? MAIN_BOT_DEFAULT_LOGO,
      active: false,
      provider: main.provider,
      model: main.model,
      effort: main.effort,
      fallback: main.fallback.map((f) => ({ provider: f.provider, model: f.model, effort: f.effort ?? null })),
    },
  };
}

/** The model settings wrapped in bot tabs, then the panel output card (ADR-0017). */
export function ReviewerPanel({ workspaceId, settings, isLoading, isMember, onSave, isSaving, keyedProviders }: ReviewerPanelProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const botsData = useBotsQuery(workspaceId).data;
  const addBot = useSaveBotMutation(workspaceId);
  const [selected, setSelected] = useState(1);
  const [addError, setAddError] = useState<string | null>(null);

  const main = mainBotOf(settings, botsData);
  const extras = botsData?.bots ?? [];
  const tabs: BotTab[] = [main, ...extras];
  const current = extras.find((b) => b.slot === selected);
  const selectedSlot = current ? current.slot : 1;
  const draft = newBotInput(main, extras);
  const canAddMore = tabs.length < MAX_BOTS;

  const handleAdd = async () => {
    if (!draft) return;
    setAddError(null);
    try {
      await addBot.mutateAsync(draft);
      setSelected(draft.slot);
      showToast(t('botAdded'), 'success');
    } catch (err) {
      setAddError(err instanceof Error && err.message ? err.message : t('error'));
    }
  };

  return (
    <>
      <section className="flex flex-col gap-3" aria-label={t('botsTabsLabel')}>
        <BotTabs
          tabs={tabs}
          selected={selectedSlot}
          onSelect={setSelected}
          onAdd={!isMember && canAddMore ? () => void handleAdd() : undefined}
          addBlockedReason={!main.provider || !main.model ? t('botAddNeedsMain') : undefined}
          adding={addBot.isPending}
        />
        {addError && (
          <p role="alert" className="text-xs text-red-500">
            {addError}
          </p>
        )}
        <div role="tabpanel" id={BOT_PANEL_ID} aria-labelledby={botTabId(selectedSlot)}>
          {current ? (
            <ExtraBotCard
              key={current.slot}
              workspaceId={workspaceId}
              bot={current}
              main={main}
              otherNames={tabs.filter((b) => b.slot !== current.slot).map((b) => b.name)}
              keyedProviders={keyedProviders}
              isMember={isMember}
              onDeleted={() => setSelected(1)}
            />
          ) : (
            <ReviewSettingsCard
              workspaceId={workspaceId}
              settings={settings}
              isLoading={isLoading}
              isMember={isMember}
              onSave={onSave}
              isSaving={isSaving}
              keyedProviders={keyedProviders}
            />
          )}
        </div>
      </section>
      <PanelOutputCard workspaceId={workspaceId} isMember={isMember} hasActiveExtraBot={extras.some((b) => b.active)} />
    </>
  );
}
