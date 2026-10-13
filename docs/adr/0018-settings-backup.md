# ADR-0018: Settings Backup and Restore — One JSON File, Keys Sealed with a Passphrase

- **Status:** Accepted (2026-10-13).
- **Related to:** ADR-0002, ADR-0007, ADR-0008 (amendment: custom base URL), ADR-0010, ADR-0015,
  ADR-0017, docs/decisions.ar.md (batch 13, Q33)

## Context

The owner wants to download every setting, the models and the API keys as one JSON file, and to
restore that file. He named three uses:

1. **Full backup** of a workspace, restored after a mistake.
2. **Copy to another workspace** he owns.
3. **Partial restore**: only the keys, or only the model settings.

The hard rule still holds: secrets never reach logs, errors, prompts or the UI. So the file never
holds a plaintext key, and the browser never sees one.

## Decision

**Amendment — ADR-0019:** the same passphrase-encrypted `key` field may contain a versioned subscription envelope. Restore validates its provider and OAuth fields with a 20,000-character plaintext limit, and `ct` allows up to 32,768 base64url characters. Raw API keys keep the 500-character limit. Subscription restores share the provider credential lock with refresh and disconnect; a rotated/revoked refresh token requires a new sign-in.

### The file

`mergepilot-settings-<workspace-slug>-<YYYYMMDD>.json`:

```
{ format: "mergepilot-settings", version: 1, exportedAt, app: { version }, workspace: { name },
  settings: {...} | null, bots: [...],
  credentials: [{ provider, baseUrl?, last4, key?: { alg: "aes-256-gcm", kdf: "scrypt", salt, iv, tag, ct } }] }
```

- **`settings`** is the `GET /settings` DTO as it is, without `workspaceId`. It has no field list of
  its own, so a field added to the settings contract (price overrides, judge uses) is backed up with
  no change here. A test checks that every key of the DTO is in the export.
- **`bots`** are the extra bots as `GET /bots` lists them (slot, name, logo, active, provider,
  model, effort, fallback).
- **`credentials`**: provider, `baseUrl` (custom only), `last4`, and the sealed `key`. "Export
  without keys" leaves `key` out.

### Encryption (server-side only, `apps/app/src/backup/passphrase-crypto.ts`)

- The export decrypts each key with the workspace vault, on the server, and seals it at once.
- **KDF:** scrypt, N=2^15, r=8, p=1, a 32-byte key, from the passphrase (Unicode NFC) and one
  random 16-byte salt per file.
- **Cipher:** AES-256-GCM with a random 12-byte iv per key.
- **Binding:** the GCM additional data is `["mergepilot-settings", 1, provider, baseUrl]`. A key
  moved to another provider, or a custom key pointed at another server URL, no longer opens.
- **Passphrase:** at least 12 characters, required when keys are included. It is never logged or
  stored; the logger also redacts any `passphrase` field.

### API (owner only)

- **`POST /api/workspaces/:id/backup/export`**, body `{ includeKeys, passphrase? }`.
  - Answers the file with `Content-Disposition: attachment`.
  - Logs `backup.export` with `includeKeys` and counts, never the content.
- **`POST /api/workspaces/:id/backup/restore`**, body
  `{ file, passphrase?, dryRun?, sections? }`.
  - `sections` is any of `settings`, `bots`, `credentials`; the default is all three.
  - **The target is the URL's workspace**, where the caller must be owner. Nothing in the file can
    pick it; the file's names and ids are ignored.
  - The request is capped at 1 MB; a bigger one answers 413 `file_too_large`.
  - **Checks.** The file goes through zod for its format and version. Then each part goes through
    the same checks as its own route, and the answer names the field, for example
    `settings.provider` or `bots[1].name`:
    - **settings:** `SettingsUpdateSchema`, `mergeSettings` and `validateSettings`, as in
      `PUT /settings`. This covers provider ids, models, efforts, limits, the stored key behind
      every heavy, fallback and judge model, and Jev-only judge models;
    - **bots:** the slot rule (2–5, no repeat), `ReviewerBotInputSchema` and `validateFallback`, as
      in `PUT /bots/:slot`, plus unique names (409 `bot_name_taken`);
    - **credentials:** the key route's rules: a provider id, `baseUrl` only and always for
      `custom` (`base_url_not_allowed`, `custom_base_url_required`), `SaveKeyRequestSchema` on the
      decrypted key, and the SSRF guard on the URL (`ssrf_validation_error`, ADR-0010).
  - The checks see the restored keys on top of the stored ones, so a fallback may use a key
    restored in the same request.
  - **A wrong passphrase, or any change to a sealed key,** answers 400 `bad_passphrase` with no
    detail.
  - **`dryRun`** answers the preview and writes nothing:
    `{ dryRun, sections, settingsChanged: [fields], bots: n, credentials: [{ provider, last4, action: 'add'|'replace' }], keysTested: false }`.
  - **The real restore** is one transaction (`AppStore.restoreWorkspace`): it saves the settings
    like `PUT /settings`, replaces all extra bots, and upserts the keys.
    - Keys are vault-encrypted through `CredentialService.sealKey`, the same path as a typed key.
    - Restored keys are **not** re-tested against the provider. The preview says so and asks the
      owner to press "Test connection".
    - Keys left out of the file, or out of `sections`, stay as they are.
  - Logs `backup.restore` with the sections, the changed field names and counts.

### UI

A "Backup & restore" card in Settings, shown to owners only:

- **Export:** an "Include API keys (encrypted)" toggle (on by default), a passphrase and a confirm
  field, and a "Download backup" button.
- **Restore:** a dialog with a file picker, the passphrase and three section checkboxes.
  - "Preview" shows the dry-run diff.
  - "Restore now" asks for confirmation, then shows a toast.
- The card says plainly, in Arabic and English, that the file is protected by the passphrase and
  the keys cannot be recovered without it.

## Consequences

- A lost passphrase means the keys in that file are lost; the settings and bots still restore.
- A file can be copied between workspaces of the same owner, never into a workspace where the
  caller is not owner.
- No migration: the restore uses the existing tables.
- Restored keys may be stale or revoked; the first review or a "Test connection" shows it.
