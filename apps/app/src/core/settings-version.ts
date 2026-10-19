import { createHash } from 'node:crypto';
import type { WorkspaceSettings } from './types.js';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sorted(object[key])]));
  }
  return value;
}

/** A content version of the stored settings, independent of object key order. */
export function getSettingsVersion(settings: WorkspaceSettings | null): string {
  return createHash('sha256').update(JSON.stringify(sorted(settings))).digest('hex');
}
