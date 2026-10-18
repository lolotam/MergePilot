import type { KeyProvider } from '../core/types.js';
import type { ProcessReviewCredentials } from './types.js';
import type { WorkspaceCredentialStore } from './workspace-credential-store.js';

/** Credentials excluded from model construction still belong in prompt redaction. */
export async function addRedactionCredentials(
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  providers: readonly string[],
  primaryProvider: string,
  store: Pick<WorkspaceCredentialStore, 'addKnownSecrets'>,
): Promise<void> {
  for (const provider of new Set(providers)) {
    try {
      const roster = await credentials.resolveKeyRoster?.(workspaceId, provider as KeyProvider);
      if (roster) store.addKnownSecrets(roster.secrets);
    } catch {
      // A redaction-only read must not fail the review or log a credential error.
    }
    if (provider === primaryProvider) continue; // Its subscription is already the primary secret.
    try {
      // The parent row retains the subscription even when API keys are the default (ADR-0027).
      store.addKnownSecrets([await credentials.resolve(workspaceId, provider as KeyProvider)]);
    } catch {
      // Independent of the roster read: keep whichever credentials are still available.
    }
  }
}
