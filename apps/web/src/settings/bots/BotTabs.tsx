import { Plus } from 'lucide-react';
import type { BotLogo } from '../../api/bots.js';
import { useI18n } from '../../i18n/context.js';
import { BotLogoIcon } from './BotLogo.js';

export interface BotTab {
  slot: number;
  name: string;
  logo: BotLogo;
  active: boolean;
}

export interface BotTabsProps {
  tabs: readonly BotTab[];
  selected: number;
  onSelect: (slot: number) => void;
  /** Undefined hides the "+ Add bot" tab (members, or 5 bots already). */
  onAdd?: (() => void) | undefined;
  /** Why adding is not possible right now (shown as the tooltip of the disabled tab). */
  addBlockedReason?: string | undefined;
  adding?: boolean;
}

export const botTabId = (slot: number) => `bot-tab-${slot}`;
export const BOT_PANEL_ID = 'bot-tab-panel';

/** The tab strip above the model settings: one tab per bot, then "+ Add bot" (ADR-0017). */
export function BotTabs({ tabs, selected, onSelect, onAdd, addBlockedReason, adding = false }: BotTabsProps) {
  const { t, dir } = useI18n();

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    // Arrow keys follow the visual order, which is mirrored in RTL.
    const dirStep = dir === 'rtl' ? -step : step;
    const next = tabs[(index + dirStep + tabs.length) % tabs.length];
    if (next) {
      onSelect(next.slot);
      document.getElementById(botTabId(next.slot))?.focus();
    }
  };

  return (
    <div className="overflow-x-auto -mx-1 px-1 pb-1">
      <div className="flex items-end gap-1 border-b border-ink-200 dark:border-ink-800 min-w-max">
        <div role="tablist" aria-label={t('botsTabsLabel')} className="flex items-end gap-1">
          {tabs.map((tab, index) => {
            const isSelected = tab.slot === selected;
            return (
              <button
                key={tab.slot}
                id={botTabId(tab.slot)}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={BOT_PANEL_ID}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => onSelect(tab.slot)}
                onKeyDown={(e) => onKeyDown(e, index)}
                className={`inline-flex items-center gap-2 px-3 py-2 -mb-px rounded-t-lg border text-xs font-semibold whitespace-nowrap transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  isSelected
                    ? 'bg-white dark:bg-ink-900 border-ink-200 dark:border-ink-700 border-b-white dark:border-b-ink-900 text-ink-900 dark:text-ink-100'
                    : 'border-transparent text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800/50'
                }`}
              >
                <BotLogoIcon logo={tab.logo} letter={tab.name} size={18} />
                <span className="max-w-[10rem] truncate">{tab.name}</span>
                <span
                  data-testid="bot-active-dot"
                  data-active={tab.active}
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full shrink-0 ${tab.active ? 'bg-green-500' : 'bg-ink-300 dark:bg-ink-600'}`}
                />
                <span className="sr-only">{t(tab.active ? 'botStatusActive' : 'botStatusInactive')}</span>
              </button>
            );
          })}
        </div>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            disabled={adding || addBlockedReason !== undefined}
            title={addBlockedReason}
            className="inline-flex items-center gap-1 px-3 py-2 mb-1 rounded-full text-xs font-semibold whitespace-nowrap text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-950/40 disabled:opacity-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('botAddTab')}
          </button>
        )}
      </div>
    </div>
  );
}
