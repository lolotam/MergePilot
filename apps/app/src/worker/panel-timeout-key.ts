/**
 * The panel's timeout part of a marker's configHash: every bot running that slot's config check -
 * the panel the job constructs already holds only active extra bots - carries its explicit call
 * timeout override, in slot order, in a structured encoding like `skillKeyOf` (ADR-0034). In
 * consensus mode the panel selects files once with slot 1's marker, so setting, changing or
 * resetting any active bot's override must move that marker or the next review is skipped as
 * already reviewed. Undefined when no bot has an explicit override, so the pre-feature hashes
 * stay exact. Null means inherit: it contributes nothing, so resetting an override to null
 * removes its entry and the marker moves back.
 */
export function panelTimeoutKeyOf(
  bots: ReadonlyArray<{ slot: number; callTimeoutMs?: number | null | undefined }>,
): string | undefined {
  const overridden = bots
    .filter((bot) => typeof bot.callTimeoutMs === 'number')
    .map((bot) => ({ slot: bot.slot, callTimeoutMs: bot.callTimeoutMs! }))
    .sort((a, b) => a.slot - b.slot);
  if (overridden.length === 0) return undefined;
  return JSON.stringify(overridden);
}
