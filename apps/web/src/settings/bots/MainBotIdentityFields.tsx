import type { Settings, SettingsUpdate } from '@mergepilot/app/contract';
import type { BotLogo } from '../../api/bots.js';
import { useI18n } from '../../i18n/context.js';
import { useBooleanSettingSwitch } from '../useBooleanSettingSwitch.js';
import { BotIdentityFields } from './BotIdentityFields.js';

export interface MainBotIdentityFieldsProps {
  idPrefix: string;
  name: string;
  onNameChange: (name: string) => void;
  logo: BotLogo;
  onLogoChange: (logo: BotLogo) => void;
  settings: Settings | null | undefined;
  onSave: (settings: SettingsUpdate) => Promise<void>;
  isSaving: boolean;
  disabled: boolean;
  nameError?: string | undefined;
}

/** The main bot's identity and its live on/off switch (migration 0021). */
export function MainBotIdentityFields({
  idPrefix,
  name,
  onNameChange,
  logo,
  onLogoChange,
  settings,
  onSave,
  isSaving,
  disabled,
  nameError,
}: MainBotIdentityFieldsProps) {
  const { t } = useI18n();
  const active = useBooleanSettingSwitch('mainBotActive', settings, onSave, disabled || isSaving, t('error'));
  return (
    <>
      <BotIdentityFields
        idPrefix={idPrefix}
        name={name}
        onNameChange={onNameChange}
        logo={logo}
        onLogoChange={onLogoChange}
        active={active.checked}
        onActiveChange={() => active.toggle()}
        activeBusy={active.busy}
        activeLabel={t('botMainActiveLabel')}
        disabled={disabled}
        nameError={nameError}
      />
      {active.error && <p role="alert" className="text-xs text-red-500">{active.error}</p>}
    </>
  );
}
