import { randomUUID } from 'node:crypto';
import { decodeSubscription } from '../../../credentials/subscription.js';
import type { Secret } from '../../../credentials/secret.js';
import { LlmAdapter, type OutputTokenRequest } from '../../../llm/adapter.js';
import { LlmFailure } from '../../../llm/failure.js';
import { DEFAULT_RETRY_POLICY } from '../../../llm/retry.js';
import type { FinishReason, GenerateOptions, StreamChunk } from '../../../llm/types.js';
import { SubscriptionRefreshError } from '../refresh-error.js';
import { antigravityHeaders } from './config.js';
import { antigravityFailure, ANTIGRAVITY_PROVIDER } from './errors.js';
import { antigravityOutputTokens, generateRequestBody, parseChunk, sseJson, usageOf } from './protocol.js';
import { fetchWithHosts, type FetchFn } from './transport.js';

function finishOf(reason: string | undefined): FinishReason {
  if (reason === 'MAX_TOKENS') return 'max-tokens';
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT') return 'error';
  return 'stop';
}

/**
 * Why the credential could not be resolved before a call. Only a refresh Google refused means
 * "sign in again"; an unreachable token endpoint, or a lock or database error while loading the
 * credential, is transient so the call is retried.
 */
function resolveFailure(error: unknown, signal: AbortSignal | undefined): LlmFailure {
  if (signal?.aborted) return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'ABORTED', message: 'request aborted' });
  if (error instanceof SubscriptionRefreshError) {
    return error.transient
      ? new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'NETWORK', message: 'Could not refresh the Google Antigravity sign-in; try again' })
      : new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'INVALID_CREDENTIAL', message: 'Google Antigravity sign-in expired or was revoked; sign in again' });
  }
  return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'SERVER', message: 'Could not load the Google Antigravity credential; try again' });
}

function thrownFailure(error: unknown, signal: AbortSignal | undefined): LlmFailure {
  if (error instanceof LlmFailure) return error;
  if (signal?.aborted) return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'ABORTED', message: 'request aborted' });
  const timeout = error instanceof Error && error.name === 'TimeoutError';
  return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: timeout ? 'TIMEOUT' : 'NETWORK', message: 'Could not reach Google Antigravity' });
}

/**
 * Google Antigravity consumer subscription (ADR-0032): one text-only `streamGenerateContent` call
 * on the account's Cloud Code Assist project. Tokens are resolved again before each call so a
 * long review uses the refreshed credential the service stored under its lock.
 */
export class AntigravityAdapter extends LlmAdapter {
  override readonly provider = ANTIGRAVITY_PROVIDER;
  override readonly retryPolicy = DEFAULT_RETRY_POLICY;

  constructor(
    private secret: Secret,
    private readonly resolveSecret?: () => Promise<Secret>,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
  ) { super(); }

  override requestedOutputTokens(options: OutputTokenRequest): number {
    return antigravityOutputTokens(options);
  }

  private async credential(signal: AbortSignal | undefined) {
    if (this.resolveSecret) {
      try {
        this.secret = await this.resolveSecret();
      } catch (error) {
        throw resolveFailure(error, signal);
      }
    }
    let envelope;
    try {
      envelope = decodeSubscription(this.secret.reveal(), ANTIGRAVITY_PROVIDER);
    } catch {
      // A malformed or foreign envelope: only a new sign-in repairs it.
    }
    const projectId = envelope?.credential.projectId;
    if (envelope && typeof projectId === 'string' && projectId) return { access: envelope.credential.access, projectId };
    throw new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'INVALID_CREDENTIAL', message: 'Google Antigravity sign-in is required; sign in again' });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { access, projectId } = await this.credential(options.signal);
    let response: Response;
    try {
      response = await fetchWithHosts(this.fetchFn, 'streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: antigravityHeaders(access, true),
        body: JSON.stringify(generateRequestBody(options, projectId, `agent-${randomUUID()}`)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw thrownFailure(error, options.signal);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw antigravityFailure(response.status, text, options.model);
    }
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    try {
      for await (const event of sseJson(response.body)) {
        const chunk = parseChunk(event);
        if (chunk.error) throw antigravityFailure(chunk.error.status, chunk.error.body, options.model);
        if (chunk.text) yield { type: 'text-delta', text: chunk.text };
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (error) {
      throw thrownFailure(error, options.signal);
    }
    // Only a candidate's finishReason ends an answer; a stream that just stops was cut off.
    if (!finishReason) {
      throw new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'NETWORK', message: 'Google Antigravity stream ended before the answer was complete' });
    }
    yield { type: 'usage', usage: usageOf(usage) };
    yield { type: 'finish', reason: finishOf(finishReason) };
  }
}
