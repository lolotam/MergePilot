import type { ApiProvider, AppStore } from '../core/types.js';
import type { Settings } from './contract.js';

export interface SettingsProblem {
  code: string;
  message: string;
}

/**
 * Checks what the schema cannot: the heavy-duty model is all-or-nothing, and every model
 * the worker may switch to (heavy model, fallbacks) has a stored key in this workspace (a
 * `custom` key also needs its stored base URL). A workspace has one `custom` credential, so
 * every `custom` entry (primary, heavy or fallback) uses that one server URL.
 */
export async function validateSettings(
  store: AppStore,
  workspaceId: string,
  settings: Settings,
): Promise<SettingsProblem | null> {
  const keyProblem = async (provider: ApiProvider, code: string, role: string): Promise<SettingsProblem | null> => {
    const cred = await store.getCredential(workspaceId, provider);
    if (!cred) return { code, message: `Stored API key required for ${role} provider: ${provider}` };
    if (provider === 'custom' && !cred.baseUrl) {
      return { code, message: `The custom key for the ${role} model has no base URL; save the key again with its URL` };
    }
    return null;
  };

  const { heavyProvider, heavyModel, heavyEffort } = settings;
  if (Boolean(heavyProvider) !== Boolean(heavyModel?.trim())) {
    return { code: 'validation_error', message: 'heavyProvider and heavyModel must be set together' };
  }
  if (heavyEffort && !heavyModel) {
    return { code: 'validation_error', message: 'heavyEffort needs a heavy model' };
  }
  if (heavyProvider) {
    const problem = await keyProblem(heavyProvider, 'heavy_key_missing', 'heavy');
    if (problem) return problem;
  }

  const seen = new Set<string>([`${settings.provider}\u0000${settings.model}`]);
  for (const entry of settings.fallback ?? []) {
    const id = `${entry.provider}\u0000${entry.model}`;
    if (seen.has(id)) {
      return {
        code: 'fallback_duplicate',
        message: `Fallback ${entry.provider}:${entry.model} repeats the primary model or another fallback`,
      };
    }
    seen.add(id);
    const problem = await keyProblem(entry.provider, 'fallback_key_missing', 'fallback');
    if (problem) return problem;
  }
  return null;
}
