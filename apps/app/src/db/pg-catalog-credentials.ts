import { and, asc, eq } from 'drizzle-orm';
import { effectiveKeyCursor } from '../core/key-cursor.js';
import type { CatalogCredentialState, KeyProvider } from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { providerApiKeys, providerAuthPreferences, providerCredentials, providerKeyCursors } from './schema.js';

/** One statement sees either side of a credential transaction, including its slot order and default. */
export async function readPgCatalogCredentialState(
  db: AppDb, workspaceId: string, provider: KeyProvider,
): Promise<CatalogCredentialState | null> {
  const rows = await db.select({
    parent: {
      id: providerCredentials.id, createdAt: providerCredentials.createdAt,
      baseUrl: providerCredentials.baseUrl, signInRequiredAt: providerCredentials.signInRequiredAt,
    },
    slot: { id: providerApiKeys.id, position: providerApiKeys.position, createdAt: providerApiKeys.createdAt },
    cursor: providerKeyCursors.position,
    preference: providerAuthPreferences.defaultMethod,
  }).from(providerCredentials)
    .leftJoin(providerApiKeys, and(eq(providerApiKeys.workspaceId, workspaceId), eq(providerApiKeys.provider, provider)))
    .leftJoin(providerKeyCursors, and(eq(providerKeyCursors.workspaceId, workspaceId), eq(providerKeyCursors.provider, provider)))
    .leftJoin(providerAuthPreferences, and(eq(providerAuthPreferences.workspaceId, workspaceId), eq(providerAuthPreferences.provider, provider)))
    .where(and(eq(providerCredentials.workspaceId, workspaceId), eq(providerCredentials.provider, provider)))
    .orderBy(asc(providerApiKeys.position));
  const first = rows[0];
  if (!first) return null;
  const slots = rows.flatMap(({ slot }) => slot ? [slot] : []);
  return { parent: first.parent, slots, cursor: effectiveKeyCursor(first.cursor, slots.length), preference: first.preference };
}
