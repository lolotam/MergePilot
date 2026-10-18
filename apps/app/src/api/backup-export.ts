import { deriveBackupKey, newBackupSalt, sealBackupKey } from '../backup/passphrase-crypto.js';
import type { AppStore } from '../core/types.js';
import { isDualMethodProvider, isKeyListProvider } from '../credentials/multi-key.js';
import type { CredentialService } from '../credentials/service.js';
import { BackupChangedError, withSkillName } from './backup-skills.js';

export { BackupChangedError };
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupCredential, type BackupFile, type BackupSkill } from './contract-backup.js';

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
  counts: { settings: boolean; bots: number; credentials: number; keys: number; skills: number };
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
  const [stored, bots, keys, skillList] = await Promise.all([
    deps.store.getSettings(workspace.id),
    deps.store.listReviewerBots(workspace.id),
    deps.credentials.listKeys(workspace.id),
    deps.store.listReviewSkills(workspace.id),
  ]);
  // The GET /settings DTO without the workspace id (the target comes from the URL), its skill by
  // name: skill ids differ between workspaces (ADR-0034).
  let settings: Record<string, unknown> | null = null;
  if (stored) {
    const { workspaceId: _ws, ...dto } = stored;
    settings = withSkillName(dto, skillList);
  }
  const skills: BackupSkill[] = [];
  for (const summary of skillList) {
    const skill = await deps.store.getReviewSkill(workspace.id, summary.id);
    // A skill deleted since the listing would leave the settings or bots naming a skill the file
    // lacks, and they would restore on Default: refuse an incomplete backup instead.
    if (!skill) throw new BackupChangedError();
    // The listed name, which the settings and bots above name too, even if a rename raced the export.
    skills.push({ name: summary.name, content: skill.content });
  }

  const salt = options.includeKeys ? newBackupSalt() : null;
  const fileKey = salt && options.passphrase ? await deriveBackupKey(options.passphrase, salt) : null;
  const credentials: BackupCredential[] = [];
  for (const meta of keys) {
    if (fileKey && salt) {
      if (isKeyListProvider(meta.provider)) {
        const roster = await deps.credentials.revealRoster(workspace.id, meta.provider);
        const sealedKeys = roster.map((item) =>
          sealBackupKey(item.secret.reveal(), fileKey, salt, { provider: meta.provider, baseUrl: null }),
        );
        const effectiveDefault = isDualMethodProvider(meta.provider) ? meta.defaultMethod : undefined;
        if (isDualMethodProvider(meta.provider) && meta.hasSubscription) {
          const resolved = await deps.credentials.resolveCredential(workspace.id, meta.provider);
          const subSealed = sealBackupKey(resolved.secret.reveal(), fileKey, salt, { provider: meta.provider, baseUrl: null });
          credentials.push({
            provider: meta.provider,
            last4: meta.last4,
            key: subSealed,
            ...(sealedKeys.length > 0 ? { keys: sealedKeys } : {}),
            ...(effectiveDefault ? { defaultMethod: effectiveDefault } : {}),
          });
          continue;
        }
        const first = sealedKeys[0];
        credentials.push({
          provider: meta.provider,
          last4: roster[0]?.last4 ?? meta.last4,
          ...(first ? { key: first, keys: sealedKeys } : {}),
          ...(effectiveDefault ? { defaultMethod: effectiveDefault } : {}),
        });
        continue;
      }
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
    bots: bots.map((b) => withSkillName({ ...b }, skillList)),
    credentials,
    skills,
  };
  return {
    file,
    filename: backupFilename(workspace.slug, options.now),
    counts: {
      settings: settings !== null,
      bots: bots.length,
      credentials: credentials.length,
      keys: credentials.filter((c) => c.key).length,
      skills: skills.length,
    },
  };
}
