import type { Settings, SettingsUpdate } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { useBooleanSettingSwitch } from '../useBooleanSettingSwitch.js';
import { BotActiveSwitch } from './BotLogo.js';

export interface BotsMasterSwitchProps {
  settings: Settings | null | undefined;
  onSave: (settings: SettingsUpdate) => Promise<void>;
  isMember: boolean;
  isSaving: boolean;
}

/** The master on/off switch above the bot tabs; each bot keeps its own saved switch. */
export function BotsMasterSwitch({ settings, onSave, isMember, isSaving }: BotsMasterSwitchProps) {
  const { t } = useI18n();
  const master = useBooleanSettingSwitch('botsEnabled', settings, onSave, isMember || isSaving, t('error'));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <BotActiveSwitch
          checked={master.checked}
          disabled={master.disabled}
          onChange={() => master.toggle()}
          label={t('botsMasterLabel')}
        />
        <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">{t('botsMasterLabel')}</span>
      </div>
      <p className="text-[11px] text-ink-500 dark:text-ink-400 ms-12">{t('botsMasterHint')}</p>
      {master.error && <p role="alert" className="text-xs text-red-500 ms-12">{master.error}</p>}
    </div>
  );
}
