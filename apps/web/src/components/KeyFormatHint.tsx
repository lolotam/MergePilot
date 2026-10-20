import { useI18n } from '../i18n/context.js';

/** MiniMax Coding Plan (Token Plan) keys start with this prefix; pay-as-you-go keys do not. */
const CODING_PLAN_PREFIX = 'sk-cp-';
/** The modal asks for at least 8 characters; a shorter value says nothing about its format. */
const MIN_KEY_LENGTH = 8;

/**
 * Warns when the typed key looks like it belongs to the other MiniMax provider: a pay-as-you-go
 * key saved as a Coding Plan key does not use the plan and may fail with HTTP 402 "insufficient
 * balance", and a Coding Plan key saved as pay-as-you-go cannot use the plan at all.
 */
export function keyFormatHint(
  provider: string,
  value: string,
): 'minimaxCodingPlanKeyHint' | 'minimaxPayAsYouGoKeyHint' | null {
  const trimmed = value.trim();
  if (trimmed.length < MIN_KEY_LENGTH) return null;
  const isCodingPlanKey = trimmed.startsWith(CODING_PLAN_PREFIX);
  if (provider === 'minimax-coding-plan' && !isCodingPlanKey) return 'minimaxCodingPlanKeyHint';
  if (provider === 'minimax' && isCodingPlanKey) return 'minimaxPayAsYouGoKeyHint';
  return null;
}

export interface KeyFormatHintProps {
  provider: string;
  value: string;
}

/** A warning under the key input. It never blocks saving or testing the key. */
export function KeyFormatHint({ provider, value }: KeyFormatHintProps) {
  const { t } = useI18n();
  const key = keyFormatHint(provider, value);
  if (!key) return null;
  return (
    <p role="note" className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 ms-2">
      {t(key)}
    </p>
  );
}
