import { useState } from 'react';
import type { Settings } from '@mergepilot/app/contract';

/**
 * The bot's call timeout override in milliseconds (ADR-0048): the contract's `callTimeoutMs`, an
 * integer between 1000 and 1200000. `null` means inherit the repository's effective timeout.
 */
export type CallTimeoutMs = NonNullable<Settings['callTimeoutMs']>;

// The server's CALL_TIMEOUT_MIN_MS and CALL_TIMEOUT_MAX_MS (the web never imports server runtime code).
// The field shows seconds, the API stores whole milliseconds.
export const CALL_TIMEOUT_MIN_MS = 1000;
export const CALL_TIMEOUT_MAX_MS = 1200000;

/** What the field holds: empty = inherit, a number of seconds, or a value to refuse. */
export type CallTimeoutParse =
  | { kind: 'empty' }
  | { kind: 'ok'; ms: CallTimeoutMs }
  | { kind: 'invalid' }
  | { kind: 'outOfRange' };

/**
 * The stored milliseconds as the field shows them: '' for inherit, '600' for ten minutes, '1.5'
 * for 1500 ms. Built from integers, so a value that came from the server comes back exactly.
 */
export function formatCallTimeoutSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  const rest = ms % 1000;
  if (rest === 0) return String(seconds);
  return `${seconds}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/**
 * The typed seconds as whole milliseconds. A fraction of a millisecond, a value out of range and
 * anything that is not a plain number are refused: nothing is clamped or truncated silently.
 */
export function parseCallTimeoutSeconds(text: string): CallTimeoutParse {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return { kind: 'invalid' };
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  // Three decimals are milliseconds; a longer fraction is a fraction of a millisecond.
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) return { kind: 'invalid' };
  const ms = Number(whole) * 1000 + Number(fraction.slice(0, 3).padEnd(3, '0'));
  if (!Number.isSafeInteger(ms)) return { kind: 'invalid' };
  if (ms < CALL_TIMEOUT_MIN_MS || ms > CALL_TIMEOUT_MAX_MS) return { kind: 'outOfRange' };
  return { kind: 'ok', ms };
}

/**
 * The call timeout field's state (ADR-0048): the seconds the field shows, and the stored value it
 * was filled from (the base of a changed timeout). The field follows the server on its own, so a
 * refetch that does not change the timeout keeps an unsaved edit.
 */
export function useCallTimeoutField(savedMs: number | null) {
  const [value, setValue] = useState(() => formatCallTimeoutSeconds(savedMs));
  const [shownMs, setShownMs] = useState<number | null>(savedMs);
  if (shownMs !== savedMs) {
    setShownMs(savedMs);
    setValue(formatCallTimeoutSeconds(savedMs));
  }
  return { value, setValue, shownMs };
}
