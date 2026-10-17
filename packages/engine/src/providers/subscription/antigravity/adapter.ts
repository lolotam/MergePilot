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

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
/** Google's reasons are enum names; anything else is not put in a message. */
const ENUM_NAME = /^[A-Z_]{2,40}$/;

function reasonText(reason: string): string {
  return ENUM_NAME.test(reason) ? ` (${reason})` : '';
}

/** Google declined the prompt or the answer: retrying the same review gets the same refusal. */
function refusal(reason: string): LlmFailure {
  return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'BAD_REQUEST', message: `Google Antigravity declined to answer${reasonText(reason)}` });
}

/** Only STOP is a clean end and MAX_TOKENS a cut one; every other reason fails the call. */
function finishOf(reason: string): FinishReason {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'max-tokens';
  if (BLOCKED_FINISH.has(reason)) throw refusal(reason);
  // OTHER, MALFORMED_FUNCTION_CALL, FINISH_REASON_UNSPECIFIED, or a reason added later.
  throw new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'UNKNOWN', message: `Google Antigravity ended the answer abnormally${reasonText(reason)}` });
}

/**
 * Why the credential could not be resolved before a call. Only a refresh Google refused means
 * "sign in again"; an unreachable token endpoint, or a lock or database error while loading the
 * credential, is transient so the call is retried.
 */
function resolveFailure(error: unknown, signal: AbortSignal | undefined): LlmFailure {
  if (signal?.aborted) return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'ABORTED', message: 'request aborted' });
  if (error instanceof SubscriptionRefreshError) {
    if (error.reason === 'unreachable') {
      return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'NETWORK', message: 'Could not refresh the Google Antigravity sign-in; try again' });
    }
    if (error.reason === 'not-configured') {
      return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'PROVIDER_NOT_CONFIGURED', message: 'Google Antigravity sign-in is not configured on this server' });
    }
    return new LlmFailure({ provider: ANTIGRAVITY_PROVIDER, code: 'INVALID_CREDENTIAL', message: 'Google Antigravity sign-in expired or was revoked; sign in again' });
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
        // A blocked prompt has no candidates at all; it is a refusal, not a cut-off stream.
        if (chunk.blockReason) throw refusal(chunk.blockReason);
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
    const finish = finishOf(finishReason);
    yield { type: 'usage', usage: usageOf(usage) };
    yield { type: 'finish', reason: finish };
  }
}
