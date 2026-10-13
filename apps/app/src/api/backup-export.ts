import { deriveBackupKey, newBackupSalt, sealBackupKey } from '../backup/passphrase-crypto.js';
import type { AppStore } from '../core/types.js';
import type { CredentialService } from '../credentials/service.js';
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupCredential, type BackupFile } from './contract-backup.js';

// Settings backup export (ADR-0018). The keys are decrypted with the workspace vault and sealed
// with the owner's passphrase here, on the server; the response never carries a plaintext key.

/** The app version written into the file (the PRD version; the format has its own `version`). */
export const BACKUP_APP_VERSION = '0.2';

export interface BackupExportOptions {
  includeKeys: boolean;
  /** Required (checked by the route) when `includeKeys`. */
  passphrase?: string | undefined;
  now: Date;
}

export interface BackupExportResult {
  file: BackupFile;
  filename: string;
  counts: { settings: boolean; bots: number; credentials: number; keys: number };
}

/** `mergepilot-settings-<workspace-slug>-<YYYYMMDD>.json`; the slug keeps only safe characters. */
export function backupFilename(slug: string, now: Date): string {
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `mergepilot-settings-${safeSlug}-${day}.json`;
}

export async function buildBackupFile(
  deps: { store: AppStore; credentials: CredentialService },
  workspace: { id: string; name: string; slug: string },
  options: BackupExportOptions,
): Promise<BackupExportResult> {
  const [stored, bots, keys] = await Promise.all([
    deps.store.getSettings(workspace.id),
    deps.store.listReviewerBots(workspace.id),
    deps.credentials.listKeys(workspace.id),
  ]);
  // The GET /settings DTO as it is, without the workspace id (the target comes from the URL).
  let settings: Record<string, unknown> | null = null;
  if (stored) {
    const { workspaceId: _ws, ...dto } = stored;
    settings = dto;
  }

  const salt = options.includeKeys ? newBackupSalt() : null;
  const fileKey = salt && options.passphrase ? await deriveBackupKey(options.passphrase, salt) : null;
  const credentials: BackupCredential[] = [];
  for (const meta of keys) {
    if (fileKey && salt) {
      // The key and its URL come from ONE read, so a custom key rotated with a new URL during the
      // export can never be sealed (and later restored) against the old endpoint.
      const resolved = await deps.credentials.resolveCredential(workspace.id, meta.provider);
      const baseUrl = meta.provider === 'custom' ? (resolved.baseUrl ?? null) : null;
      credentials.push({
        provider: meta.provider,
        ...(baseUrl ? { baseUrl } : {}),
        last4: meta.last4,
        key: sealBackupKey(resolved.secret.reveal(), fileKey, salt, { provider: meta.provider, baseUrl }),
      });
      continue;
    }
    const baseUrl = meta.provider === 'custom' ? (meta.baseUrl ?? null) : null;
    credentials.push({ provider: meta.provider, ...(baseUrl ? { baseUrl } : {}), last4: meta.last4 });
  }

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: options.now.toISOString(),
    app: { version: BACKUP_APP_VERSION },
    workspace: { name: workspace.name },
    settings,
    bots: bots.map((b) => ({ ...b })),
    credentials,
  };
  return {
    file,
    filename: backupFilename(workspace.slug, options.now),
    counts: {
      settings: settings !== null,
      bots: bots.length,
      credentials: credentials.length,
      keys: credentials.filter((c) => c.key).length,
    },
  };
}
