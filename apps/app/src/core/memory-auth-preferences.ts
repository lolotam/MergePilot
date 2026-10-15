import type { KeyProvider, ProviderAuthMethod } from './types.js';

const slotKey = (workspaceId: string, provider: string): string => `${workspaceId}:${provider}`;

export interface MemoryAuthPreferences {
  authPreferences: Map<string, ProviderAuthMethod>;
}

export function readMemoryAuthPreference(
  tables: MemoryAuthPreferences,
  workspaceId: string,
  provider: KeyProvider,
): ProviderAuthMethod | null {
  return tables.authPreferences.get(slotKey(workspaceId, provider)) ?? null;
}

export function writeMemoryAuthPreference(
  tables: MemoryAuthPreferences,
  workspaceId: string,
  provider: KeyProvider,
  method: ProviderAuthMethod,
): void {
  tables.authPreferences.set(slotKey(workspaceId, provider), method);
}

export function deleteMemoryAuthPreference(tables: MemoryAuthPreferences, workspaceId: string, provider: KeyProvider): void {
  tables.authPreferences.delete(slotKey(workspaceId, provider));
}

export function deleteMemoryWorkspaceAuthPreferences(tables: MemoryAuthPreferences, workspaceId: string): void {
  for (const key of tables.authPreferences.keys()) {
    if (key.startsWith(`${workspaceId}:`)) tables.authPreferences.delete(key);
  }
}
