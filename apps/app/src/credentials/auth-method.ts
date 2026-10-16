import type { ProviderAuthMethod } from '../core/types.js';

/** ADR-0027 §3: stored preference when that method exists, else whichever method is available. */
export function effectiveAuthMethod(
  preference: ProviderAuthMethod | null,
  hasSubscription: boolean,
  hasApiKeys: boolean,
): ProviderAuthMethod | null {
  if (preference === 'subscription' && hasSubscription) return 'subscription';
  if (preference === 'api-key' && hasApiKeys) return 'api-key';
  if (hasSubscription) return 'subscription';
  if (hasApiKeys) return 'api-key';
  return null;
}
