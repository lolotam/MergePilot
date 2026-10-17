import type { ReviewerBot } from './bot-types.js';
import type { NewReviewSkill } from './skill-types.js';
import type { KeyProvider, ProviderKeyChange, StoredCredential, StoredProviderKey, WorkspaceSettings } from './types.js';

// Settings restore (ADR-0018). Re-exported by types.ts.

export type RestoreProviderKeyChange = (
  current: StoredProviderKey[],
  parent: StoredCredential | null,
) => Promise<ProviderKeyChange>;

/** One dual-method provider applied atomically inside restoreWorkspace. */
export interface RestoreProviderKeyEntry {
  provider: KeyProvider;
  change: RestoreProviderKeyChange;
}

/** What one restore writes; a section left undefined is not touched. */
export interface WorkspaceRestore {
  /** Saved like PUT /settings (undefined fields keep the stored value). */
  settings?: WorkspaceSettings | undefined;
  /** Replaces every extra bot (slots 2-5) of the workspace; [] removes them all. */
  bots?: ReviewerBot[] | undefined;
  /** Vault-encrypted keys, upserted by provider; credentials not listed stay as they are. */
  credentials?: StoredCredential[] | undefined;
  /**
   * Slot rows for providers in this restore (ADR-0026). Undefined leaves every slot list
   * untouched. An empty array is a no-op. A non-empty list replaces that provider's slots.
   */
  providerKeys?: StoredProviderKey[] | undefined;
  /** ADR-0027 dual providers: one locked change per entry inside the restore transaction. */
  dualProviderKeyChanges?: RestoreProviderKeyEntry[] | undefined;
  /**
   * Review skills (ADR-0034), written first: a skill whose id exists in the workspace is replaced,
   * the others are inserted. Skills not listed stay.
   */
  skills?: NewReviewSkill[] | undefined;
}

/** The restore part of AppStore. */
export interface BackupRestoreStore {
  /**
   * Writes the restore in one transaction: everything or nothing. Throws BotNameTakenError when
   * two bot names (the main bot's and the extra bots') clash ignoring case, InvalidBotSlotError
   * for a slot outside 2-5, and WorkspaceDeletedError when the workspace is gone.
   */
  restoreWorkspace(workspaceId: string, restore: WorkspaceRestore): Promise<void>;
}
