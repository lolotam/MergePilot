import { z } from 'zod';

export const SUBSCRIPTION_PROVIDERS = ['openai', 'anthropic', 'xai', 'google-antigravity'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** Providers that have no API-key method at all (ADR-0032, decisions log س47-د). */
export const SUBSCRIPTION_ONLY_PROVIDERS = ['google-antigravity'] as const;
export type SubscriptionOnlyProvider = (typeof SUBSCRIPTION_ONLY_PROVIDERS)[number];
/** Subscriptions whose login and request protocol come from pi-ai (ADR-0020). */
export type PiSubscriptionProvider = Exclude<SubscriptionProvider, SubscriptionOnlyProvider>;

export function isSubscriptionOnlyProvider(provider: string): provider is SubscriptionOnlyProvider {
  return (SUBSCRIPTION_ONLY_PROVIDERS as readonly string[]).includes(provider);
}
export const SUBSCRIPTION_PREFIX = 'mergepilot:oauth:v1:';

const CredentialSchema = z.object({
  type: z.literal('oauth'),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().finite().nonnegative(),
}).catchall(z.unknown());
const EnvelopeSchema = z.object({
  provider: z.enum(SUBSCRIPTION_PROVIDERS),
  credential: CredentialSchema,
});
export type SubscriptionCredential = z.infer<typeof CredentialSchema>;

export function isSubscriptionProvider(provider: string): provider is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider);
}

/** A versioned value kept inside the existing encrypted credential column. */
export function encodeSubscription(provider: SubscriptionProvider, credential: SubscriptionCredential): string {
  const value = SUBSCRIPTION_PREFIX + JSON.stringify(EnvelopeSchema.parse({ provider, credential }));
  if (value.length > 20_000) throw new Error('Subscription credential exceeds the storage limit');
  return value;
}

/** Rejects malformed credentials and credentials moved to a different provider. */
export function decodeSubscription(value: string, provider?: string): z.infer<typeof EnvelopeSchema> | undefined {
  if (!value.startsWith(SUBSCRIPTION_PREFIX)) return undefined;
  try {
    if (value.length > 20_000) throw new Error('Credential too large');
    const parsed = EnvelopeSchema.parse(JSON.parse(value.slice(SUBSCRIPTION_PREFIX.length)));
    if (provider !== undefined && parsed.provider !== provider) throw new Error('Provider mismatch');
    return parsed;
  } catch {
    throw new Error('Invalid subscription credential; sign in again');
  }
}

/** Redact individual tokens as well as the serialized envelope. */
export function credentialSecretValues(value: string): string[] {
  try {
    const subscription = decodeSubscription(value);
    return subscription ? [value, subscription.credential.access, subscription.credential.refresh] : [value];
  } catch {
    // Malformed persisted/env credentials still need their raw value redacted from error output, and
    // any token still readable inside them on its own: a review can continue on a fallback model.
    return [value, ...malformedEnvelopeTokens(value)];
  }
}

/** Best-effort `credential.access` / `credential.refresh` strings of an envelope that failed validation. */
function malformedEnvelopeTokens(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value.slice(SUBSCRIPTION_PREFIX.length));
    const credential = (parsed as { credential?: unknown } | null)?.credential;
    if (!credential || typeof credential !== 'object') return [];
    const { access, refresh } = credential as { access?: unknown; refresh?: unknown };
    return [access, refresh].filter((token): token is string => typeof token === 'string' && token.length > 0);
  } catch {
    return [];
  }
}
