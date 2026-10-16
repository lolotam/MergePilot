import { z } from 'zod';
import { API_PROVIDER_IDS } from '@mergepilot/engine';
import {
  DUAL_METHOD_PROVIDER_IDS,
  isDualMethodProvider,
  isKeyListProvider,
  isMultiKeyProvider,
  MAX_PROVIDER_KEYS,
  MULTI_KEY_PROVIDER_IDS,
} from '../credentials/multi-key.js';

export {
  DUAL_METHOD_PROVIDER_IDS,
  isDualMethodProvider,
  isKeyListProvider,
  isMultiKeyProvider,
  MAX_PROVIDER_KEYS,
  MULTI_KEY_PROVIDER_IDS,
};

// Model choice shapes shared by the settings and the reviewer panel's bots. Re-exported by contract.ts.

export const ApiProviderSchema = z.enum(API_PROVIDER_IDS);
export type ApiProvider = z.infer<typeof ApiProviderSchema>;

/** A thinking effort as providers name it (off / on / minimal / low / medium / high / xhigh / max ...). */
export const EffortSchema = z.string().regex(/^[a-z0-9_-]{1,24}$/, 'Invalid effort');
export const ModelIdSchema = z.string().trim().min(1).max(200);

export const MAX_FALLBACK_MODELS = 3;

export const FallbackEntrySchema = z.object({
  provider: ApiProviderSchema,
  model: ModelIdSchema,
  effort: EffortSchema.nullable().optional(),
});
export type FallbackEntry = z.infer<typeof FallbackEntrySchema>;
