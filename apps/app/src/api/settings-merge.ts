import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceSettings } from '../core/types.js';
import type { SettingsBase, SettingsUpdate } from './contract.js';

type SettingsField = keyof Omit<SettingsUpdate, 'base'>;

/**
 * The fields that only make sense together: an effort belongs to its model, and the heavy
 * model to its provider and its effort. A change to one of them is a change to the whole
 * group. The heavy threshold is not one of them: it sizes the diff, not the heavy model.
 */
const SETTINGS_GROUPS: readonly (readonly SettingsField[])[] = [
  ['provider', 'model', 'effort'],
  ['heavyProvider', 'heavyModel', 'heavyEffort'],
];

/** The fields every PUT body carries, so they keep their stored value instead of being left out. */
const REQUIRED_FIELDS: readonly SettingsField[] = ['provider', 'model', 'language'];

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

/** The stored value of a field (nothing when the workspace has no settings yet). */
function storedValue(previous: WorkspaceSettings | null, key: string): unknown {
  return previous ? Reflect.get(previous, key) : undefined;
}

/** True when the stored field still holds the value the client read in its base. */
function storedMatchesBase(previous: WorkspaceSettings | null, base: SettingsBase, key: string): boolean {
  return isDeepStrictEqual(normalized(storedValue(previous, key)), normalized(base[key]));
}

/**
 * The fields the client changed: its value differs from the base it read. Null when the
 * store moved away from that base, so the edit is stale.
 */
function changedFields(
  submitted: Omit<SettingsUpdate, 'base'>,
  base: SettingsBase,
  previous: WorkspaceSettings | null,
): Set<string> | null {
  const changed = new Set<string>();
  for (const [key, value] of Object.entries(submitted)) {
    if (!Object.hasOwn(base, key)) continue;
    if (isDeepStrictEqual(normalized(value), normalized(base[key]))) continue;
    changed.add(key);
    // The stored value must still be the base the client read.
    if (!storedMatchesBase(previous, base, key)) return null;
  }
  return changed;
}

/**
 * The fields of a group that change together: when the client changed one of them, every
 * field of the group must still hold the value it read, so an effort is never kept for
 * another model. The fields the patch left out are checked too: an effort chosen for a
 * model another admin changed meanwhile must not land on the new model. Only the fields
 * the client sent are written. Null when the store moved away from that base.
 */
function changedGroupFields(
  submitted: Omit<SettingsUpdate, 'base'>,
  base: SettingsBase,
  previous: WorkspaceSettings | null,
  changed: ReadonlySet<string>,
): Set<string> | null {
  const groupFields = new Set<string>();
  for (const group of SETTINGS_GROUPS) {
    if (!group.some((key) => changed.has(key))) continue;
    for (const key of group) {
      // Every field of the group must still hold the value the client read.
      if (Object.hasOwn(base, key) && !storedMatchesBase(previous, base, key)) return null;
      if (Object.hasOwn(submitted, key)) groupFields.add(key);
    }
  }
  return groupFields;
}

/**
 * Drops unchanged fields and rejects client edits whose base no longer matches the stored value.
 * The fields of a group change together: when one of them changed, every field of the group
 * must still hold the value the client read, so an effort is never kept for another model.
 * Without a base there is nothing to compare: the save writes every field it sends (last write
 * wins for those fields) and only a race inside the request answers 409. The dashboard does not
 * send a base yet, so its saves keep these semantics until it does.
 */
export function reconcileSettingsPatch(
  submitted: Omit<SettingsUpdate, 'base'>,
  base: SettingsBase | undefined,
  previous: WorkspaceSettings | null,
): Omit<SettingsUpdate, 'base'> | null {
  const patch = { ...submitted };
  if (!base) return patch;

  // The fields the client changed: its value differs from the base it read.
  const changed = changedFields(submitted, base, previous);
  if (!changed) return null;
  // A group changes as a whole: a change to one of its fields changes all of them.
  const groupChanged = changedGroupFields(submitted, base, previous, changed);
  if (!groupChanged) return null;

  for (const [key] of Object.entries(submitted)) {
    // The client changed it, or changed the group it belongs to: it is written as it was sent.
    if (changed.has(key) || groupChanged.has(key)) continue;
    // A field the client did not baseline is written as it was sent.
    if (!Object.hasOwn(base, key)) continue;
    // The client did not change it: the stored value wins.
    if (!REQUIRED_FIELDS.includes(key as SettingsField)) {
      Reflect.deleteProperty(patch, key);
      continue;
    }
    if (!previous) return null;
    Object.assign(patch, { [key]: storedValue(previous, key) });
  }
  return patch;
}
