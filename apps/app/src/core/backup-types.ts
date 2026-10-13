import type { ReviewerBot } from './bot-types.js';
import type { StoredCredential, WorkspaceSettings } from './types.js';

// Settings restore (ADR-0018). Re-exported by types.ts.

/** What one restore writes; a section left undefined is not touched. */
export interface WorkspaceRestore {
  /** Saved like PUT /settings (undefined fields keep the stored value). */
  settings?: WorkspaceSettings | undefined;
  /** Replaces every extra bot (slots 2-5) of the workspace; [] removes them all. */
  bots?: ReviewerBot[] | undefined;
  /** Vault-encrypted keys, upserted by provider; credentials not listed stay as they are. */
  credentials?: StoredCredential[] | undefined;
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
