import { redactSecrets, type FallbackDisclosure, type Secret } from '@mergepilot/engine';

/** Why a fallback model took over, ready for a summary or a log line (ADR-0008). */
export interface FallbackReason {
  from: string;
  code: string;
  /** The provider's answer: redacted, one line, at most `MAX_FALLBACK_DETAIL` characters. */
  detail?: string;
  /** ADR-0027: set when the review switched auth method on the same provider and model. */
  fromMethod?: 'subscription' | 'api-key';
  usedMethod?: 'subscription' | 'api-key';
}

export const MAX_FALLBACK_DETAIL = 300;

/**
 * The fallback reason of a review, or undefined when no fallback took over. The provider's whole
 * message is redacted first and only then cleaned and cut, so a known secret is never split
 * before redaction can match it.
 */
export function fallbackReasonOf(
  disclosure: Partial<
    Pick<
      FallbackDisclosure,
      'fallbackFrom' | 'fallbackCode' | 'fallbackDetail' | 'fallbackFromMethod' | 'modelUsedMethod'
    >
  >,
  knownSecrets: Secret[],
): FallbackReason | undefined {
  if (!disclosure.fallbackFrom || !disclosure.fallbackCode) return undefined;
  const detail = disclosure.fallbackDetail ? shortenDetail(redactSecrets(disclosure.fallbackDetail, knownSecrets).text) : '';
  const methodSwitch =
    disclosure.fallbackFromMethod && disclosure.modelUsedMethod
      ? { fromMethod: disclosure.fallbackFromMethod, usedMethod: disclosure.modelUsedMethod }
      : {};
  return { from: disclosure.fallbackFrom, code: disclosure.fallbackCode, ...(detail ? { detail } : {}), ...methodSwitch };
}

/** One line without control characters, cut by code points (never inside a surrogate pair). */
export function shortenDetail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > MAX_FALLBACK_DETAIL ? `${chars.slice(0, MAX_FALLBACK_DETAIL - 1).join('')}…` : clean;
}
