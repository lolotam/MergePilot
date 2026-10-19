import type { Settings, SettingsBase, SettingsUpdate } from '@mergepilot/app/contract';

/** Captures the payload and its field baselines together, before the mutation can be queued. */
export function withSettingsBase<T extends Omit<SettingsUpdate, 'base'>>(
  update: T,
  snapshot: Settings | null | undefined,
): T & { base: SettingsBase } {
  const previous = snapshot as Record<string, unknown> | null | undefined;
  const base = Object.fromEntries(Object.keys(update).map((key) => [key, previous?.[key] ?? null]));
  return structuredClone({ ...update, base });
}
