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

/** Whitespace runs (line breaks included) as one space, so an item stays one markdown list line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The answer's `withheld` list as the items to keep: a value that is not a list, an item that
 * fails the schema and an item whose texts are empty are skipped, and each text is put on one
 * line. Texts are cut only after redaction (`redactWithheld`), so a cut never splits a secret.
 * Never throws: a bad list must not drop the summary or the findings.
 */
export function parseWithheld(raw: unknown): WithheldItem[] {
  if (!Array.isArray(raw)) return [];
  const elements = raw as unknown[];
  const items: WithheldItem[] = [];
  for (const element of elements) {
    if (items.length >= MAX_WITHHELD_ITEMS) break;
    const parsed = WithheldItemSchema.safeParse(element);
    if (!parsed.success) continue;
    const title = oneLine(parsed.data.title);
    const reason = oneLine(parsed.data.reason);
    if (!title || !reason) continue;
    items.push({ title, reason });
  }
  return items;
}

/**
 * The batches' lists as one: in order, without a repeated title (compared trimmed and lower
 * cased), and capped like a single list.
 */
export function mergeWithheld(lists: ReadonlyArray<readonly WithheldItem[] | undefined>): WithheldItem[] {
  const merged: WithheldItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      if (merged.length >= MAX_WITHHELD_ITEMS) return merged;
      const key = item.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ title: item.title, reason: item.reason });
    }
  }
  return merged;
}

/**
 * The withheld items with the review's known secrets redacted, then cut to their maximum length:
 * their text came from a model answer about PR-controlled code, like a summary or a finding.
 */
export function redactWithheld(items: readonly WithheldItem[], knownSecrets: readonly Secret[]): WithheldItem[] {
  const secrets = [...knownSecrets];
  return items.map((item) => ({
    title: redactSecrets(item.title, secrets).text.slice(0, WITHHELD_TITLE_MAX_CHARS),
    reason: redactSecrets(item.reason, secrets).text.slice(0, WITHHELD_REASON_MAX_CHARS),
  }));
}
