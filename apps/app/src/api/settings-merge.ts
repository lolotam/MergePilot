import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceSettings } from '../core/types.js';
import type { SettingsBase, SettingsUpdate } from './contract.js';

function normalized(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, normalized(entry)]));
  }
  return value;
}

/** Drops unchanged fields and rejects client edits whose base no longer matches the stored value. */
export function reconcileSettingsPatch(
  submitted: Omit<SettingsUpdate, 'base'>,
  base: SettingsBase | undefined,
  previous: WorkspaceSettings | null,
): Omit<SettingsUpdate, 'base'> | null {
  const patch = { ...submitted };
  if (!base) return patch;
  for (const [key, value] of Object.entries(submitted)) {
    if (!Object.hasOwn(base, key)) continue;
    if (isDeepStrictEqual(normalized(value), normalized(base[key]))) {
      if (key === 'provider' || key === 'model' || key === 'language') {
        if (!previous) return null;
        Object.assign(patch, { [key]: previous[key] });
      } else {
        Reflect.deleteProperty(patch, key);
      }
    } else if (!isDeepStrictEqual(normalized(previous ? Reflect.get(previous, key) : undefined), normalized(base[key]))) {
      return null;
    }
  }
  return patch;
}
