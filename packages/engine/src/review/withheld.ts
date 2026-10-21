/**
 * Withheld problems (ADR-0042): what the model noticed in the pull request but did not report as
 * a finding, each with the reason why (below the confidence bar, out of scope, already open, or
 * over the findings limit). The list is optional in the answer and lenient when it is parsed: a
 * bad item is skipped, never the answer, its summary or its findings.
 */

import { z } from 'zod';
import type { Secret } from '../credentials/secret.js';
import { redactSecrets } from '../security/redact.js';

/** One problem the model noticed and did not report, with the reason it did not report it. */
export const WithheldItemSchema = z.object({ title: z.string().min(1), reason: z.string().min(1) });

export type WithheldItem = z.infer<typeof WithheldItemSchema>;

/** At most this many withheld items are kept; the rest are dropped. */
export const MAX_WITHHELD_ITEMS = 10;
/** A withheld title is cut to this many characters. */
export const WITHHELD_TITLE_MAX_CHARS = 200;
/** A withheld reason is cut to this many characters. */
export const WITHHELD_REASON_MAX_CHARS = 300;

/**
 * Whitespace runs (line breaks included) as one space, so an item stays one markdown list line.
 * Applied after the redaction, on the raw text, so a known secret is matched before it is
 * normalised.
 */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Cut to `max` code points, never inside a surrogate pair (like `shortenDetail` in the GitHub package). */
const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * The answer's `withheld` list as the items to keep: a value that is not a list, an item that
 * fails the schema and an item whose texts are empty are skipped. The texts are kept exactly as
 * the model sent them: the redaction, the one line and the cut happen later (`redactWithheld`),
 * so a known secret that spans a line break or repeated spaces is still matched. Never throws:
 * a bad list must not drop the summary or the findings.
 */
export function parseWithheld(raw: unknown): WithheldItem[] {
  if (!Array.isArray(raw)) return [];
  const elements = raw as unknown[];
  const items: WithheldItem[] = [];
  for (const element of elements) {
    if (items.length >= MAX_WITHHELD_ITEMS) break;
    const parsed = WithheldItemSchema.safeParse(element);
    if (!parsed.success) continue;
    const { title, reason } = parsed.data;
    if (!title.trim() || !reason.trim()) continue;
    items.push({ title, reason });
  }
  return items;
}

/**
 * The batches' lists as one: in order, without a repeated title (compared on one line, trimmed
 * and lower cased), and capped like a single list.
 */
export function mergeWithheld(lists: ReadonlyArray<readonly WithheldItem[] | undefined>): WithheldItem[] {
  const merged: WithheldItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      if (merged.length >= MAX_WITHHELD_ITEMS) return merged;
      const key = oneLine(item.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ title: item.title, reason: item.reason });
    }
  }
  return merged;
}

/**
 * The withheld items with the review's known secrets redacted, then put on one line and cut to
 * their maximum length: their text came from a model answer about PR-controlled code, like a
 * summary or a finding. The redaction runs on the raw text, so a known secret that contains a
 * line break or repeated spaces is matched before the text is normalised.
 */
export function redactWithheld(items: readonly WithheldItem[], knownSecrets: readonly Secret[]): WithheldItem[] {
  const secrets = [...knownSecrets];
  return items.map((item) => ({
    title: cut(oneLine(redactSecrets(item.title, secrets).text), WITHHELD_TITLE_MAX_CHARS),
    reason: cut(oneLine(redactSecrets(item.reason, secrets).text), WITHHELD_REASON_MAX_CHARS),
  }));
}
