import { and, eq } from 'drizzle-orm';
import type { KeyProvider, ProviderAuthMethod } from '../core/types.js';
import { providerAuthPreferences } from './schema.js';
import type { AppDb } from './pg-store.js';
import type { AppTx } from './workspace-lock.js';

type PgReader = AppDb | AppTx;

export async function readPgAuthPreference(
  db: PgReader,
  workspaceId: string,
  provider: KeyProvider,
): Promise<ProviderAuthMethod | null> {
  const rows = await db
    .select({ defaultMethod: providerAuthPreferences.defaultMethod })
    .from(providerAuthPreferences)
    .where(and(eq(providerAuthPreferences.workspaceId, workspaceId), eq(providerAuthPreferences.provider, provider)));
  const method = rows[0]?.defaultMethod;
  return method === 'subscription' || method === 'api-key' ? method : null;
}

export async function writePgAuthPreference(
  tx: AppTx,
  workspaceId: string,
  provider: KeyProvider,
  method: ProviderAuthMethod,
): Promise<void> {
  const updatedAt = new Date();
  await tx
    .insert(providerAuthPreferences)
    .values({ workspaceId, provider, defaultMethod: method, updatedAt })
    .onConflictDoUpdate({
      target: [providerAuthPreferences.workspaceId, providerAuthPreferences.provider],
      set: { defaultMethod: method, updatedAt },
    });
}

export async function deletePgAuthPreference(tx: AppTx, workspaceId: string, provider: KeyProvider): Promise<void> {
  await tx
    .delete(providerAuthPreferences)
    .where(and(eq(providerAuthPreferences.workspaceId, workspaceId), eq(providerAuthPreferences.provider, provider)));
}

export async function deletePgWorkspaceAuthPreferences(tx: AppTx, workspaceId: string): Promise<void> {
  await tx.delete(providerAuthPreferences).where(eq(providerAuthPreferences.workspaceId, workspaceId));
}
