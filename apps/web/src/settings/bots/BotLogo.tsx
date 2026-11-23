import { useEffect, useId, useState } from 'react';
import type { BotLogo } from '../../api/bots.js';
import type { I18nKey } from '../../i18n/ar.js';
import { useI18n } from '../../i18n/context.js';

/** Every preset logo with its label (the server's BOT_LOGOS; type-checked to cover them all). */
export const BOT_LOGO_LABELS: Record<BotLogo, I18nKey> = {
  pilot: 'botLogoPilot',
  owl: 'botLogoOwl',
  fox: 'botLogoFox',
  robot: 'botLogoRobot',
  rocket: 'botLogoRocket',
  shield: 'botLogoShield',
  bolt: 'botLogoBolt',
  eye: 'botLogoEye',
  brain: 'botLogoBrain',
  star: 'botLogoStar',
  leaf: 'botLogoLeaf',
  wave: 'botLogoWave',
};
export const BOT_LOGO_KEYS = Object.keys(BOT_LOGO_LABELS) as BotLogo[];

export const MAIN_BOT_DEFAULT_NAME = 'MergePilot';
export const MAIN_BOT_DEFAULT_LOGO: BotLogo = 'pilot';
export const MAX_BOT_NAME_LENGTH = 40;
export const MAX_BOTS = 5;
export const EXTRA_BOT_SLOTS = [2, 3, 4, 5] as const;

/** Names compare trimmed and ignoring case, like the server's unique index. */
export function sameBotName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The name-field error key for a typed bot name, or null when it is valid. */
export function botNameError(name: string): I18nKey | null {
  const trimmed = name.trim();
  if (!trimmed) return 'botNameRequired';
  if (trimmed.length > MAX_BOT_NAME_LENGTH) return 'botNameTooLong';
  return null;
}

export interface BotLogoIconProps {
  /** Undefined when unknown (e.g. a run of a deleted bot): the letter is shown. */
  logo: BotLogo | undefined;
  /** The first character is shown when the logo is unknown or its SVG fails to load. */
  letter: string;
  size?: number;
}

/** The bot's preset logo from `/bots/<key>.svg`, or its first letter when the image is missing. */
export function BotLogoIcon({ logo, letter, size = 16 }: BotLogoIconProps) {
  const [failed, setFailed] = useState<BotLogo | null>(null);
  if (!logo || failed === logo) {
    return (
      <span
        aria-hidden="true"
        data-testid="bot-logo-letter"
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.6)) }}
        className="inline-flex items-center justify-center shrink-0 rounded-full bg-brand-100 dark:bg-brand-900/60 text-brand-700 dark:text-brand-300 font-bold leading-none"
      >
        {(letter.trim()[0] ?? '?').toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`/bots/${logo}.svg`}
      width={size}
      height={size}
      alt=""
      onError={() => setFailed(logo)}
      className="shrink-0 rounded-full"
      style={{ width: size, height: size }}
    />
  );
}

export interface BotLogoPickerProps {
  id: string;
  value: BotLogo;
  onChange: (logo: BotLogo) => void;
  disabled?: boolean;
}

/** A grid of the 12 preset logos; the chosen one has a ring. */
export function BotLogoPicker({ id, value, onChange, disabled = false }: BotLogoPickerProps) {
  const { t } = useI18n();
  return (
    <div>
      <span id={`${id}-label`} className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
        {t('botLogoLabel')}
      </span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="grid grid-cols-6 sm:grid-cols-12 gap-2">
        {BOT_LOGO_KEYS.map((key) => {
          const selected = key === value;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t(BOT_LOGO_LABELS[key])}
              title={t(BOT_LOGO_LABELS[key])}
              disabled={disabled}
              onClick={() => onChange(key)}
              className={`aspect-square flex items-center justify-center rounded-xl border transition-colors disabled:opacity-60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${
                selected
                  ? 'border-brand-500 ring-2 ring-brand-500 bg-brand-50 dark:bg-brand-950/50'
                  : 'border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800'
              }`}
            >
              <BotLogoIcon logo={key} letter={t(BOT_LOGO_LABELS[key])} size={24} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface BotActiveSwitchProps {
  checked: boolean;
  onChange: (active: boolean) => void;
  disabled?: boolean;
  /** Accessible name, when the switch needs a name more specific than «Bot active». */
  label?: string | undefined;
  /** An optional tooltip. */
  title?: string | undefined;
}

/** An on/off switch; the thumb moves to the end side in both directions. */
export function BotActiveSwitch({ checked, onChange, disabled = false, label, title }: BotActiveSwitchProps) {
  const { t } = useI18n();
  const hintId = useId();
  // The thumb slides at once on a click, not after the save answers; once the switch is free again
  // (the save ended) it follows the saved value, so a failed save slides it back. A changed saved
  // value always shows, even on a switch that stays disabled (a member).
  const [shown, setShown] = useState(checked);
  useEffect(() => setShown(checked), [checked]);
  useEffect(() => {
    if (!disabled) setShown(checked);
  }, [disabled]);
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      {title ? (
        <span id={hintId} className="sr-only">
          {title}
        </span>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={label ?? t('botActiveLabel')}
        aria-describedby={title ? hintId : undefined}
        disabled={disabled}
        onClick={() => {
          setShown(!shown);
          onChange(!shown);
        }}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${
          shown ? 'bg-green-500' : 'bg-ink-300 dark:bg-ink-700'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 start-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
            shown ? 'translate-x-4 rtl:-translate-x-4' : ''
          }`}
        />
      </button>
      <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">
        {t(shown ? 'botStatusActive' : 'botStatusInactive')}
      </span>
    </span>
  );
}
