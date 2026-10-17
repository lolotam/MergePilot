import { SUBSCRIPTION_PREFIX } from '@mergepilot/engine';
import { BadPassphraseError, deriveBackupKey, openBackupKey, sealedKeySalt, type SealedKey } from '../backup/passphrase-crypto.js';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import {
  DEFAULT_BOT_NAME,
  isExtraBotSlot,
  sameBotName,
  type AppStore,
  type KeyProvider,
  type ReviewerBot,
  type StoredCredential,
  type StoredProviderKey,
  type WorkspaceRestore,
  type WorkspaceSettings,
} from '../core/types.js';
import { decodeSubscription } from '@mergepilot/engine';
import { assertPlaintextNotSubscriptionEnvelope } from '../credentials/key-list-helpers.js';
import { dualRestoreOverlayCredential, type DualProviderRestorePlan } from '../credentials/dual-restore.js';
import { isDualMethodProvider, isKeyListProvider, MAX_PROVIDER_KEYS } from '../credentials/multi-key.js';
import { SubscriptionEnvelopeInKeyListError } from '../credentials/service.js';
import type { CredentialService } from '../credentials/service.js';
import { ReviewerBotInputSchema, SaveKeyRequestSchema, SettingsUpdateSchema } from './contract.js';
import {
  BACKUP_FORMAT,
  BACKUP_SECTIONS,
  BACKUP_VERSION,
  BackupFileSchema,
  type BackupFile,
  type BackupPreview,
  type BackupSection,
} from './contract-backup.js';
import { botNameTakenByExtraBot, mergeSettings, validateFallback, validateSettings } from './settings-validation.js';
import { RestoreProblem, zodProblem } from './backup-restore-problem.js';
import { planSkills, resolveSkillName, takeSkillRef, type SkillRestorePlan } from './backup-skills.js';

// Settings restore (ADR-0018): every part of a (possibly hand-edited) file goes through the same
// checks as PUT /settings, PUT /bots/:slot and PUT /keys/:provider before anything is written.

export interface RestoreDeps {
  store: AppStore;
  credentials: CredentialService;
  ssrfLookup?: DnsLookupFn | undefined;
}

export interface RestoreRequest {
  workspaceId: string;
  userId: string;
  file: unknown;
  passphrase?: string | undefined;
  sections?: readonly BackupSection[] | undefined;
}

export { RestoreProblem };

export interface RestorePlan {
  restore: WorkspaceRestore;
  preview: Omit<BackupPreview, 'dryRun'>;
}

/** Which settings field a validateSettings problem is about. */
const SETTINGS_PROBLEM_FIELDS: Record<string, string> = {
  validation_error: 'settings.heavyModel',
  heavy_key_missing: 'settings.heavyProvider',
  fallback_duplicate: 'settings.fallback',
  fallback_key_missing: 'settings.fallback',
};

function parseFile(raw: unknown): BackupFile {
  const head = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (head.format !== BACKUP_FORMAT) {
    throw new RestoreProblem(400, 'invalid_backup_format', 'This is not a MergePilot settings backup file', 'format');
  }
  if (head.version !== BACKUP_VERSION) {
    throw new RestoreProblem(400, 'unsupported_backup_version', `Only backup version ${BACKUP_VERSION} can be restored`, 'version');
  }
  const parsed = BackupFileSchema.safeParse(raw);
  if (!parsed.success) throw zodProblem('', parsed.error);
  return parsed.data;
}

function slotFromCredential(credential: StoredCredential, position: number): StoredProviderKey {
  return {
    id: credential.id,
    workspaceId: credential.workspaceId,
    provider: credential.provider,
    position,
    ciphertext: credential.ciphertext,
    keyVersion: credential.keyVersion,
    last4: credential.last4,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    lastTestStatus: null,
    lastTestedAt: null,
  };
}

/** Decrypts, checks and vault-encrypts the file's keys; keys left out of the file are skipped. */
async function planCredentials(
  deps: RestoreDeps,
  req: RestoreRequest,
  file: BackupFile,
): Promise<{
  credentials: StoredCredential[];
  providerKeys: StoredProviderKey[];
  dualProviderPlans: DualProviderRestorePlan[];
}> {
  const sealed = file.credentials.flatMap((c, index) =>
    c.key || (c.keys && c.keys.length > 0) ? [{ ...c, index }] : [],
  );
  if (sealed.length === 0) return { credentials: [], providerKeys: [], dualProviderPlans: [] };
  if (!req.passphrase) throw new RestoreProblem(400, 'passphrase_required', 'This file has encrypted keys: type its passphrase', 'passphrase');
  const passphrase = req.passphrase;

  const seen = new Set<KeyProvider>();
  const derived = new Map<string, Promise<Buffer>>();
  const out: StoredCredential[] = [];
  const providerKeys: StoredProviderKey[] = [];
  const dualProviderPlans: DualProviderRestorePlan[] = [];
  for (const entry of sealed) {
    const field = `credentials[${entry.index}]`;
    if (seen.has(entry.provider)) throw new RestoreProblem(400, 'validation_error', `${field}.provider: ${entry.provider} appears twice`, `${field}.provider`);
    seen.add(entry.provider);
    const baseUrl = entry.baseUrl?.trim() || null;
    if (entry.provider === 'custom' && !baseUrl) {
      throw new RestoreProblem(400, 'custom_base_url_required', 'Base URL is required for custom provider', `${field}.baseUrl`);
    }
    if (entry.provider !== 'custom' && baseUrl) {
      throw new RestoreProblem(400, 'base_url_not_allowed', 'Only the custom provider takes a base URL', `${field}.baseUrl`);
    }

    const sources: SealedKey[] = entry.keys && entry.keys.length > 0 ? [...entry.keys] : entry.key ? [entry.key] : [];
    if (sources.length > MAX_PROVIDER_KEYS) {
      throw new RestoreProblem(400, 'too_many_keys', `This provider accepts at most ${MAX_PROVIDER_KEYS} API keys`, field);
    }
    if (!isKeyListProvider(entry.provider) && entry.keys && entry.keys.length > 0) {
      throw new RestoreProblem(400, 'single_key_provider', 'This provider stores one credential', field);
    }
    if (entry.defaultMethod && !isDualMethodProvider(entry.provider)) {
      throw new RestoreProblem(400, 'validation_error', 'defaultMethod is only for dual-method providers', `${field}.defaultMethod`);
    }

    const openSealed = async (sealedKey: SealedKey, keyField: string): Promise<{ credential: StoredCredential; plaintext: string }> => {
      let apiKey: string;
      try {
        const salt = sealedKeySalt(sealedKey);
        const cacheKey = salt.toString('base64url');
        if (!derived.has(cacheKey)) derived.set(cacheKey, deriveBackupKey(passphrase, salt));
        apiKey = openBackupKey(sealedKey, await (derived.get(cacheKey) as Promise<Buffer>), { provider: entry.provider, baseUrl });
      } catch (err) {
        if (err instanceof BadPassphraseError) throw new RestoreProblem(400, 'bad_passphrase', 'Wrong passphrase, or the file was changed');
        throw err;
      }
      const keySchema = apiKey.startsWith(SUBSCRIPTION_PREFIX)
        ? SaveKeyRequestSchema.extend({ apiKey: SaveKeyRequestSchema.shape.apiKey.max(20_000) })
        : SaveKeyRequestSchema;
      const shape = keySchema.safeParse({ apiKey: apiKey.trim(), ...(baseUrl ? { baseUrl } : {}) });
      if (!shape.success) throw zodProblem(keyField, shape.error, apiKey);
      // The key route checks the shape, then the SSRF guard, and only then seals (ADR-0010).
      // A changed base URL already failed above as a bad passphrase, because the seal is bound to it.
      if (baseUrl) {
        try {
          await assertSafeBaseUrl(baseUrl, deps.ssrfLookup);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Base URL is not allowed';
          throw new RestoreProblem(400, 'ssrf_validation_error', message, `${field}.baseUrl`);
        }
      }
      try {
        const credential = await deps.credentials.sealKey(
          { workspaceId: req.workspaceId, provider: entry.provider, apiKey, userId: req.userId, baseUrl },
          { validate: false },
        );
        return { credential, plaintext: apiKey.trim() };
      } catch (err) {
        const message = (err instanceof Error ? err.message : 'Key rejected').replaceAll(apiKey, '[REDACTED]');
        throw new RestoreProblem(400, 'credential_rejected', message, keyField);
      }
    };

    if (isKeyListProvider(entry.provider) && isDualMethodProvider(entry.provider)) {
      const defaultMethod = entry.defaultMethod ?? null;
      const openSlotKey = async (sealedKey: SealedKey, keyField: string, position: number) => {
        const { credential, plaintext } = await openSealed(sealedKey, keyField);
        try {
          assertPlaintextNotSubscriptionEnvelope(plaintext, entry.provider);
        } catch (err) {
          if (err instanceof SubscriptionEnvelopeInKeyListError) {
            throw new RestoreProblem(400, 'subscription_in_key_list', err.message, keyField);
          }
          throw err;
        }
        return slotFromCredential(credential, position);
      };
      const keysFieldPresent = Object.hasOwn(entry, 'keys');
      if (entry.key) {
        const { credential: parentCred, plaintext } = await openSealed(entry.key, `${field}.key`);
        if (decodeSubscription(plaintext, entry.provider)) {
          const keys: StoredProviderKey[] = keysFieldPresent
            ? await Promise.all(
                (entry.keys ?? []).map((sealedKey, position) =>
                  openSlotKey(sealedKey, `${field}.keys[${position}]`, position),
                ),
              )
            : [];
          dualProviderPlans.push({
            provider: entry.provider,
            subscriptionParent: parentCred,
            keys,
            defaultMethod,
            subscriptionParentFromFile: true,
            keysFieldPresent,
          });
          continue;
        }
      }
      const keySources = keysFieldPresent ? [...(entry.keys ?? [])] : sources;
      const keys: StoredProviderKey[] = [];
      for (const [position, sealedKey] of keySources.entries()) {
        keys.push(await openSlotKey(sealedKey, `${field}.keys[${position}]`, position));
      }
      dualProviderPlans.push({
        provider: entry.provider,
        subscriptionParent: null,
        keys,
        defaultMethod,
        subscriptionParentFromFile: false,
        keysFieldPresent,
      });
      continue;
    }

    if (isKeyListProvider(entry.provider)) {
      const keySources = entry.keys && entry.keys.length > 0 ? [...entry.keys] : sources;
      const sealedCreds: StoredCredential[] = [];
      for (const [position, sealedKey] of keySources.entries()) {
        const { credential, plaintext } = await openSealed(sealedKey, `${field}.${entry.keys && entry.keys.length > 0 ? 'keys' : 'key'}`);
        try {
          assertPlaintextNotSubscriptionEnvelope(plaintext, entry.provider);
        } catch (err) {
          if (err instanceof SubscriptionEnvelopeInKeyListError) {
            throw new RestoreProblem(400, 'subscription_in_key_list', err.message, field);
          }
          throw err;
        }
        sealedCreds.push(credential);
        providerKeys.push(slotFromCredential(credential, position));
      }
      const first = sealedCreds[0];
      if (first) out.push(first);
      continue;
    }

    const only = sources[0];
    if (!only) continue;
    out.push((await openSealed(only, `${field}.key`)).credential);
  }
  return { credentials: out, providerKeys, dualProviderPlans };
}

/**
 * The store as the checks should see it after the restore: the restored keys on top of the stored
 * ones, so a fallback or the judge may use a key restored in the same request.
 */
function overlayStore(
  store: AppStore,
  credentials: readonly StoredCredential[],
  dualPlans: readonly DualProviderRestorePlan[] = [],
  hasConnectedSubscription: (workspaceId: string, provider: KeyProvider) => Promise<boolean> = async () => false,
): AppStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'getCredential') {
        return async (workspaceId: string, provider: KeyProvider) => {
          const dual = dualPlans.find((plan) => plan.provider === provider);
          if (dual) {
            const overlay = dualRestoreOverlayCredential(dual);
            if (overlay) return { ...overlay, workspaceId };
            // No subscription and no keys in the file: only a connected subscription survives the restore.
            if (!(await hasConnectedSubscription(workspaceId, provider))) return null;
            return target.getCredential(workspaceId, provider);
          }
          return credentials.find((c) => c.provider === provider) ?? target.getCredential(workspaceId, provider);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The file's settings through PUT /settings' schema, merge and checks; returns the merged settings. */
async function planSettings(
  checkStore: AppStore,
  workspaceId: string,
  raw: Record<string, unknown>,
  previous: WorkspaceSettings | null,
  skills: SkillRestorePlan,
  missingSkills: Set<string>,
): Promise<WorkspaceSettings> {
  // The file names the main bot's skill by name (ADR-0034); an older file without it keeps the skill.
  const ref = takeSkillRef(raw, 'settings');
  const parsed = SettingsUpdateSchema.safeParse(ref.rest);
  if (!parsed.success) throw zodProblem('settings', parsed.error);
  const update = ref.present ? { ...parsed.data, skillId: resolveSkillName(skills, ref.name, missingSkills) } : parsed.data;
  const merged = mergeSettings(workspaceId, previous, update);
  const problem = await validateSettings(checkStore, workspaceId, merged);
  if (problem) {
    const field = problem.code.startsWith('judge_') ? 'settings.judge' : (SETTINGS_PROBLEM_FIELDS[problem.code] ?? 'settings');
    throw new RestoreProblem(400, problem.code, problem.message, field);
  }
  return merged;
}

/** Each bot through PUT /bots/:slot's slot rule, schema and fallback check; names must not clash. */
async function planBots(
  checkStore: AppStore,
  workspaceId: string,
  raw: BackupFile['bots'],
  mainName: string,
  skills: SkillRestorePlan,
  missingSkills: Set<string>,
): Promise<ReviewerBot[]> {
  const bots: ReviewerBot[] = [];
  for (const [index, entry] of raw.entries()) {
    const field = `bots[${index}]`;
    const slot = entry.slot;
    if (typeof slot !== 'number' || !isExtraBotSlot(slot) || bots.some((b) => b.slot === slot)) {
      throw new RestoreProblem(400, 'invalid_slot', `${field}.slot: each extra bot needs its own slot 2-5`, `${field}.slot`);
    }
    const ref = takeSkillRef(entry, field);
    const parsed = ReviewerBotInputSchema.safeParse(ref.rest);
    if (!parsed.success) throw zodProblem(field, parsed.error);
    const input = parsed.data;
    const skillId = resolveSkillName(skills, ref.name, missingSkills);
    const bot: ReviewerBot = {
      slot,
      name: input.name,
      logo: input.logo,
      active: input.active,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      fallback: input.fallback,
      ...(skillId ? { skillId } : {}),
    };
    if (sameBotName(bot.name, mainName) || bots.some((other) => sameBotName(other.name, bot.name))) {
      throw new RestoreProblem(409, 'bot_name_taken', 'Another bot in this workspace already has this name', `${field}.name`);
    }
    const problem = await validateFallback(checkStore, workspaceId, bot, bot.fallback);
    if (problem) throw new RestoreProblem(400, problem.code, problem.message, `${field}.fallback`);
    bots.push(bot);
  }
  return bots;
}

/** Fields whose stored value changes (the same rule as the `settings.changed` log line). */
function changedFields(previous: WorkspaceSettings | null, next: WorkspaceSettings): string[] {
  const before = (previous ?? {}) as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  return Object.keys(after).filter(
    (key) => key !== 'workspaceId' && after[key] !== undefined && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
}

/**
 * Validates the whole restore and returns what to write plus the preview. Throws RestoreProblem;
 * writes nothing. The target is `req.workspaceId` (the URL's), never anything in the file.
 */
export async function planRestore(deps: RestoreDeps, req: RestoreRequest): Promise<RestorePlan> {
  const file = parseFile(req.file);
  const sections = BACKUP_SECTIONS.filter((s) => !req.sections || req.sections.includes(s));
  const restore: WorkspaceRestore = {};
  const ws = req.workspaceId;

  const planned = sections.includes('credentials')
    ? await planCredentials(deps, req, file)
    : { credentials: [], providerKeys: [], dualProviderPlans: [] };
  const credentials = planned.credentials;
  const dualProviderPlans = planned.dualProviderPlans;
  const incomingBots = sections.includes('bots') ? file.bots : undefined;
  const previous = await deps.store.getSettings(ws);
  const checkStore = overlayStore(deps.store, credentials, dualProviderPlans, (ws, provider) =>
    deps.credentials.hasConnectedSubscription(ws, provider),
  );

  // Skills first: the settings and the bots name theirs (ADR-0034).
  const skills = await planSkills(deps.store, ws, file.skills, req.userId, sections.includes('skills'));
  if (skills.skills.length > 0) restore.skills = skills.skills;
  const missingSkills = new Set<string>();

  let settingsChanged: string[] = [];
  let mainName = previous?.botName ?? DEFAULT_BOT_NAME;
  if (sections.includes('settings') && file.settings) {
    const merged = await planSettings(checkStore, ws, file.settings, previous, skills, missingSkills);
    mainName = merged.botName ?? mainName;
    settingsChanged = changedFields(previous, merged);
    // Without the bots section, the main bot's name must differ from the bots that stay.
    if (!incomingBots && merged.botName !== undefined && (await botNameTakenByExtraBot(deps.store, ws, merged.botName))) {
      throw new RestoreProblem(409, 'bot_name_taken', 'Another bot in this workspace already has this name', 'settings.botName');
    }
    restore.settings = merged;
  }
  if (incomingBots) {
    restore.bots = await planBots(checkStore, ws, incomingBots, mainName, skills, missingSkills);
  }
  if (sections.includes('credentials')) {
    restore.credentials = credentials;
    if (planned.providerKeys.length > 0) restore.providerKeys = planned.providerKeys;
    if (dualProviderPlans.length > 0) {
      restore.dualProviderKeyChanges = dualProviderPlans.map((plan) => ({
        provider: plan.provider,
        change: deps.credentials.buildDualProviderRestoreChange(plan),
      }));
    }
  }

  const preview: RestorePlan['preview'] = {
    sections: [...sections],
    settingsChanged,
    bots: restore.bots?.length ?? 0,
    skills: restore.skills?.length ?? 0,
    skillsMissing: [...missingSkills].sort(),
    credentials: (
      await Promise.all(
        [
          ...credentials,
          ...dualProviderPlans.map((dual) => ({
            provider: dual.provider,
            last4: dual.subscriptionParent?.last4 ?? dual.keys[0]?.last4 ?? '????',
          })),
        ].map(async (c) => ({
          provider: c.provider,
          last4: c.last4,
          action: (await deps.store.getCredential(ws, c.provider)) ? ('replace' as const) : ('add' as const),
        })),
      )
    ).sort((a, b) => a.provider.localeCompare(b.provider)),
    keysTested: false,
  };
  return { restore, preview };
}
