import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type { CredentialStore, Message, ThinkingLevel } from '@earendil-works/pi-ai';
import { decodeSubscription, type PiSubscriptionProvider, type SubscriptionProvider } from '../../credentials/subscription.js';
import type { Secret } from '../../credentials/secret.js';
import { LlmAdapter, type OutputTokenRequest } from '../../llm/adapter.js';
import { failureFromHttp, LlmFailure } from '../../llm/failure.js';
import { DEFAULT_RETRY_POLICY } from '../../llm/retry.js';
import { responseSchemaInstruction } from '../../llm/schema-instruction.js';
import type { GenerateOptions, StreamChunk } from '../../llm/types.js';
import { redactSecrets } from '../../security/redact.js';
import { subscriptionProvider } from './auth.js';
import { failureFromResponse } from '../http.js';
import { subscriptionOutputTokens } from './output-tokens.js';
import { SubscriptionRefreshError } from './refresh-error.js';
import { AntigravityAdapter } from './antigravity/adapter.js';

export function subscriptionModels(provider: PiSubscriptionProvider) {
  return subscriptionProvider(provider).getModels().map((model) => ({
    id: model.id,
    name: model.name,
    efforts: getSupportedThinkingLevels(model),
    contextWindow: model.contextWindow,
  }));
}

type ModelLevel = ReturnType<typeof getSupportedThinkingLevels>[number];

/**
 * The model's level for one call: `off` for a per-call thinking-off retry where the model has it,
 * else the configured effort (`none` is `off`); undefined when the model has no such level.
 */
function levelFor(levels: readonly ModelLevel[], options: OutputTokenRequest): ModelLevel | undefined {
  const effort = options.thinking === 'off' && levels.includes('off') ? 'off' : options.effort;
  return levels.find((level) => level === effort || (effort === 'none' && level === 'off'));
}

/** pi-ai reads thinking from `reasoning`; `off` is sent as no level at all. */
function reasoningFor(level: ModelLevel | undefined): ThinkingLevel | undefined {
  return level === 'off' ? undefined : level;
}

/**
 * The call's messages with its `responseSchema` appended to the leading system message, as the
 * API adapters send it. pi-ai has no structured-output option, so the prompt is the only way the
 * schema (and its required `findings` key) reaches a subscription model.
 */
function withResponseSchema(options: GenerateOptions): GenerateOptions['messages'] {
  if (!options.responseSchema) return options.messages;
  const instruction = responseSchemaInstruction(options.responseSchema);
  const [first, ...rest] = options.messages;
  if (first?.role === 'system') return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest];
  return [{ role: 'system', content: instruction }, ...options.messages];
}

/** Streams only model text; no agent tools or subprocesses are enabled. */
export class SubscriptionAdapter extends LlmAdapter {
  override readonly retryPolicy = DEFAULT_RETRY_POLICY;
  constructor(override readonly provider: PiSubscriptionProvider, private secret: Secret,
    private readonly resolveSecret?: () => Promise<Secret>) { super(); }

  override requestedOutputTokens(options: OutputTokenRequest): number {
    const model = subscriptionProvider(this.provider).getModels().find((entry) => entry.id === options.model);
    if (!model) return options.maxOutputTokens;
    const reasoning = reasoningFor(levelFor(getSupportedThinkingLevels(model), options));
    return subscriptionOutputTokens(model, reasoning, options.maxOutputTokens).requested;
  }

  /** `requestedOutputTokens` already caps every call at the subscription model's own limit. */
  override outputLimit(): undefined {
    return undefined;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let envelope;
    try {
      if (this.resolveSecret) this.secret = await this.resolveSecret();
      envelope = decodeSubscription(this.secret.reveal(), this.provider);
    } catch (error) {
      if (options.signal?.aborted) throw new LlmFailure({ provider: this.provider, code: 'ABORTED',
        message: 'Subscription credential could not be resolved; sign in again' });
      // A refresh the provider may answer later (408, 429, 5xx, no answer) stays retryable; it is not a lost sign-in.
      if (error instanceof SubscriptionRefreshError && error.transient) {
        throw new LlmFailure({ provider: this.provider, code: 'NETWORK', message: 'Could not refresh the subscription sign-in; try again' });
      }
      throw new LlmFailure({ provider: this.provider, code: 'INVALID_CREDENTIAL',
        message: 'Subscription credential could not be resolved; sign in again' });
    }
    if (!envelope) throw new LlmFailure({ provider: this.provider, code: 'INVALID_CREDENTIAL', message: 'Subscription login is required' });
    // Refreshes happen only in the credential service, under its database lock, where the rotated refresh token is persisted
    // (SUBSCRIPTION_REFRESH_MARGIN_MS). A refresh here would rotate the token in memory and discard it, which revokes the sign-in.
    const credential = envelope.credential;
    const store: CredentialStore = {
      read: async () => credential,
      list: async () => [{ providerId: subscriptionProvider(this.provider).id, type: 'oauth' }],
      modify: async () => credential,
      delete: async () => { throw new Error('Logout is owned by the credential service'); },
    };
    const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
    const provider = subscriptionProvider(this.provider);
    models.setProvider(provider);
    const model = models.getModel(provider.id, options.model);
    if (!model) throw new LlmFailure({ provider: this.provider, code: 'BAD_REQUEST', message: `Unknown subscription model: ${options.model}` });
    const level = levelFor(getSupportedThinkingLevels(model), options);
    if (options.effort !== undefined && !level) {
      throw new LlmFailure({ provider: this.provider, code: 'BAD_REQUEST', message: `Unsupported subscription effort: ${options.effort}` });
    }
    const reasoning = reasoningFor(level);
    const messages: Message[] = withResponseSchema(options).map((message) => message.role === 'assistant'
      ? { role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }
      : { role: message.role, content: message.content, timestamp: Date.now() });
    let status: number | undefined;
    let headers: Record<string, string> = {};
    let httpFailure: LlmFailure | undefined;
    let networkFailure: LlmFailure | undefined;
    try {
      for await (const event of models.streamSimple(model, { messages }, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        maxTokens: subscriptionOutputTokens(model, reasoning, options.maxOutputTokens).send,
        maxRetries: 0,
        transport: 'sse',
        fetch: async (input, init) => {
          let response: Response;
          try { response = await globalThis.fetch(input, init); }
          catch (error) {
            networkFailure = new LlmFailure({ provider: this.provider,
              code: options.signal?.aborted ? 'ABORTED' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
              message: 'Could not reach the subscription provider' });
            throw networkFailure;
          }
          status = response.status;
          headers = Object.fromEntries(response.headers);
          if (!response.ok) httpFailure = await failureFromResponse(response.clone(), this.provider, this.secret);
          return response;
        },
        onResponse(response) { status = response.status; headers = response.headers; },
      })) {
        if (event.type === 'text_delta') yield { type: 'text-delta', text: event.delta };
        if (event.type === 'error') {
          const message = redactSecrets(event.error.errorMessage ?? 'Subscription request failed', [this.secret]).text;
          if (event.reason === 'aborted') throw new LlmFailure({ provider: this.provider, code: 'ABORTED', message });
          if (httpFailure) throw httpFailure;
          if (networkFailure) throw networkFailure;
          if (status && status >= 400) throw failureFromHttp({ provider: this.provider, status, headers, bodyText: message });
          throw new LlmFailure({ provider: this.provider, code: 'UNKNOWN', message });
        }
        if (event.type === 'done') {
          const usage = event.message.usage;
          yield { type: 'usage', usage: { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } };
          yield { type: 'finish', reason: event.reason === 'length' ? 'max-tokens' : 'stop' };
          return;
        }
      }
      throw new LlmFailure({ provider: this.provider, code: 'UNKNOWN', message: 'Subscription stream ended without a result' });
    } catch (error) {
      if (error instanceof LlmFailure) throw error;
      throw new LlmFailure({ provider: this.provider, code: options.signal?.aborted ? 'ABORTED' : 'UNKNOWN',
        message: 'Subscription request failed; test the connection or sign in again' });
    }
  }
}

/** The adapter for a stored subscription envelope: pi-ai's protocols, or Google Antigravity's own (ADR-0032). */
export function createSubscriptionAdapter(provider: SubscriptionProvider, secret: Secret,
  resolveSecret?: () => Promise<Secret>): LlmAdapter {
  if (provider === 'google-antigravity') return new AntigravityAdapter(secret, resolveSecret);
  return new SubscriptionAdapter(provider, secret, resolveSecret);
}

/** True for adapters billed to a consumer subscription: $0 incremental cost (ADR-0020, ADR-0024). */
export function isSubscriptionAdapter(adapter: LlmAdapter): boolean {
  return adapter instanceof SubscriptionAdapter || adapter instanceof AntigravityAdapter;
}
