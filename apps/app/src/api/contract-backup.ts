import { z } from 'zod';
import { MAX_EXTRA_BOTS } from '../core/bot-types.js';
import { MAX_PROVIDER_KEYS } from '../credentials/multi-key.js';
import { KeyProviderSchema } from './contract-judge.js';

// Settings backup and restore (ADR-0018). Re-exported by contract.ts. A backup file never holds a
// plaintext key: each key is sealed with a passphrase the owner types (scrypt + AES-256-GCM).

export const BACKUP_FORMAT = 'mergepilot-settings';
export const BACKUP_VERSION = 1;
/** The restore request (file plus passphrase) is capped at 1 MB; a bigger one answers 413. */
export const BACKUP_MAX_BYTES = 1024 * 1024;
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

/** What a restore may write; the request picks any of them (default: all three). */
export const BACKUP_SECTIONS = ['settings', 'bots', 'credentials'] as const;
export const BackupSectionSchema = z.enum(BACKUP_SECTIONS);
export type BackupSection = z.infer<typeof BackupSectionSchema>;

const Base64Url = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/, 'Must be base64url');

/** One API key sealed with the passphrase; salt, iv, tag and ct are base64url. */
export const SealedKeySchema = z.object({
  alg: z.literal('aes-256-gcm'),
  kdf: z.literal('scrypt'),
  salt: Base64Url(64),
  iv: Base64Url(64),
  tag: Base64Url(64),
  ct: Base64Url(32768),
});

/** A credential in the file: `baseUrl` only for `custom`; `key` is left out by "export without keys". */
export const BackupCredentialSchema = z.object({
  provider: KeyProviderSchema,
  baseUrl: z.string().max(500).nullable().optional(),
  last4: z.string().max(4),
  /** First key, so a reader from before ADR-0026 still restores position 0. */
  key: SealedKeySchema.optional(),
  /** Full ordered list for gemini, openrouter and opencode-zen. Wins over `key` on restore. */
  keys: z.array(SealedKeySchema).max(MAX_PROVIDER_KEYS).optional(),
});
export type BackupCredential = z.infer<typeof BackupCredentialSchema>;

/**
 * The file. `settings` is the GET /settings DTO and each bot the GET /bots DTO, kept loose here:
 * the restore runs them through the same schemas and checks as PUT /settings and PUT /bots/:slot,
 * so a field added to those contracts is backed up and validated without changes here.
 */
export const BackupFileSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string().max(64),
  app: z.object({ version: z.string().max(64) }),
  workspace: z.object({ name: z.string().max(200) }),
  settings: z.record(z.string(), z.unknown()).nullable(),
  bots: z.array(z.record(z.string(), z.unknown())).max(MAX_EXTRA_BOTS),
  credentials: z.array(BackupCredentialSchema).max(KeyProviderSchema.options.length),
});
export type BackupFile = z.infer<typeof BackupFileSchema>;

/** POST (owner) /api/workspaces/:workspaceId/backup/export → the file as an attachment. */
export const ExportBackupBodySchema = z.object({
  includeKeys: z.boolean(),
  /** Required when `includeKeys`; at least 12 characters. Never logged or stored. */
  passphrase: z.string().max(MAX_PASSPHRASE_LENGTH).optional(),
});
export type ExportBackupBody = z.infer<typeof ExportBackupBodySchema>;

/**
 * POST (owner) /api/workspaces/:workspaceId/backup/restore. The target workspace is the URL's;
 * nothing in the file can pick it. `dryRun` returns the preview and writes nothing.
 */
export const RestoreBackupBodySchema = z.object({
  file: z.unknown(),
  passphrase: z.string().max(MAX_PASSPHRASE_LENGTH).optional(),
  dryRun: z.boolean().optional(),
  sections: z.array(BackupSectionSchema).min(1).max(BACKUP_SECTIONS.length).optional(),
});
export type RestoreBackupBody = z.infer<typeof RestoreBackupBodySchema>;

/** The restore answer (dry run or real): what changes. Restored keys are never re-tested. */
export const BackupPreviewSchema = z.object({
  dryRun: z.boolean(),
  sections: z.array(BackupSectionSchema),
  /** Settings fields whose value changes (empty when the settings are not restored). */
  settingsChanged: z.array(z.string()),
  /** Extra bots after the restore (they replace the current ones); 0 when bots are not restored. */
  bots: z.number().int(),
  credentials: z.array(
    z.object({ provider: KeyProviderSchema, last4: z.string(), action: z.enum(['add', 'replace']) }),
  ),
  /** Always false: press Test next to each key after the restore. */
  keysTested: z.literal(false),
});
export type BackupPreview = z.infer<typeof BackupPreviewSchema>;
