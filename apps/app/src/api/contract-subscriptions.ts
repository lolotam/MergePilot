import { z } from 'zod';

export const SubscriptionProviderSchema = z.enum(['openai', 'anthropic', 'xai']);
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>;
export const SubscriptionLoginSchema = z.object({
  id: z.string(),
  provider: SubscriptionProviderSchema,
  status: z.enum(['pending', 'ready', 'completed', 'failed', 'cancelled']),
  expiresAt: z.string(),
  notice: z.object({ message: z.string(), url: z.string().optional(), code: z.string().optional() }).optional(),
  prompt: z.object({ id: z.string(), message: z.string(), placeholder: z.string().optional() }).optional(),
  error: z.string().optional(),
});
export type SubscriptionLogin = z.infer<typeof SubscriptionLoginSchema>;
export const SubscriptionInputSchema = z.object({ promptId: z.string().uuid(), value: z.string().trim().min(1).max(8192) });
