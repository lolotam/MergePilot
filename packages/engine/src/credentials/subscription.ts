import { z } from 'zod';

export const SUBSCRIPTION_PROVIDERS = ['openai', 'anthropic', 'xai'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
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
    // Malformed persisted/env credentials still need their raw value redacted from error output.
    return [value];
  }
}
