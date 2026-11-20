import type { BotLogo } from '../../api/bots.js';
import { useI18n } from '../../i18n/context.js';
import { fieldClass, labelClass } from '../providers.js';
import { BotActiveSwitch, BotLogoPicker, MAX_BOT_NAME_LENGTH } from './BotLogo.js';

export interface BotIdentityFieldsProps {
  /** Unique per page (the main and an extra bot never render at once, but keep them apart anyway). */
  idPrefix: string;
  name: string;
  onNameChange: (name: string) => void;
  logo: BotLogo;
  onLogoChange: (logo: BotLogo) => void;
  active: boolean;
  onActiveChange: (active: boolean) => void;
  /** Accessible name; the main bot uses a more specific one. */
  activeLabel?: string | undefined;
  /** Disables the switch only (e.g. while its save is in flight). */
  activeBusy?: boolean;
  disabled: boolean;
  nameError?: string | undefined;
}

/** A bot's name, active switch and logo: the top of every bot tab (ADR-0017). */
export function BotIdentityFields({
  idPrefix,
  name,
  onNameChange,
  logo,
  onLogoChange,
  active,
  onActiveChange,
  activeLabel,
  activeBusy = false,
  disabled,
  nameError,
}: BotIdentityFieldsProps) {
  const { t } = useI18n();
  const nameId = `${idPrefix}-name`;
  return (
    <div className="flex flex-col gap-4 p-4 rounded-2xl border border-ink-200 dark:border-ink-800 bg-ink-50/50 dark:bg-ink-950/20">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 min-w-0">
          <label htmlFor={nameId} className={labelClass}>
            {t('botNameLabel')}
          </label>
          <input
            id={nameId}
            type="text"
            value={name}
            maxLength={MAX_BOT_NAME_LENGTH + 10}
            disabled={disabled}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => onNameChange(e.target.value)}
            className={nameError ? `${fieldClass} border-red-500 focus:ring-red-500` : fieldClass}
          />
          {nameError && <p className="text-xs text-red-500 mt-1 ms-2">{nameError}</p>}
        </div>
        <div className="pb-1.5">
          <BotActiveSwitch
            checked={active}
            disabled={disabled || activeBusy}
            onChange={onActiveChange}
            label={activeLabel}
          />
        </div>
      </div>
      <BotLogoPicker id={`${idPrefix}-logo`} value={logo} onChange={onLogoChange} disabled={disabled} />
    </div>
  );
}
