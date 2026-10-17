import { z } from 'zod';
import { SUBSCRIPTION_LOGIN_FAILURES, SUBSCRIPTION_ONLY_PROVIDERS, SUBSCRIPTION_PROVIDERS } from '@mergepilot/engine';

export const SubscriptionProviderSchema = z.enum(SUBSCRIPTION_PROVIDERS);
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>;

/** Providers with no API-key method (ADR-0032). Their sign-in needs the terms acknowledgement. */
export const SUBSCRIPTION_ONLY_PROVIDER_IDS = SUBSCRIPTION_ONLY_PROVIDERS;

/** Why a sign-in failed, for the dashboard's own wording. Google's bodies are never forwarded. */
export const SubscriptionLoginErrorCodeSchema = z.enum(SUBSCRIPTION_LOGIN_FAILURES);
export type SubscriptionLoginErrorCode = z.infer<typeof SubscriptionLoginErrorCodeSchema>;

export const SubscriptionLoginSchema = z.object({
  id: z.string(),
  provider: SubscriptionProviderSchema,
  status: z.enum(['pending', 'ready', 'completed', 'failed', 'cancelled']),
  expiresAt: z.string(),
  notice: z.object({ message: z.string(), url: z.string().optional(), code: z.string().optional() }).optional(),
  prompt: z.object({ id: z.string(), message: z.string(), placeholder: z.string().optional() }).optional(),
  error: z.string().optional(),
  errorCode: SubscriptionLoginErrorCodeSchema.optional(),
});
export type SubscriptionLogin = z.infer<typeof SubscriptionLoginSchema>;
export const SubscriptionInputSchema = z.object({ promptId: z.string().uuid(), value: z.string().trim().min(1).max(8192) });

/**
 * Starting a sign-in. `acknowledgedTerms` is required for Google Antigravity: Google's terms
 * forbid third-party access and the account may be suspended (decisions log س47-أ).
 */
export const SubscriptionStartSchema = z.object({ acknowledgedTerms: z.boolean().optional() }).strict();

/** The subscriptions this deployment can offer; Google Antigravity needs its OAuth client configured. */
export const SubscriptionAvailabilitySchema = z.object({ providers: z.array(SubscriptionProviderSchema) });
export type SubscriptionAvailability = z.infer<typeof SubscriptionAvailabilitySchema>;
