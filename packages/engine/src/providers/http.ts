/**
 * Small fetch helpers shared by the providers that talk HTTP directly (the OpenAI-compatible
 * adapter, the model catalog and the connection test). Every message that leaves here has
 * the caller's key redacted; header values are never copied into a message.
 */
import { Secret } from '../credentials/secret.js';
import { failureFromHttp, LlmFailure, providerMessage } from '../llm/failure.js';
import { redactSecrets } from '../security/redact.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Error bodies are read once and only up to this size, so a huge HTML page cannot stall us. */
const ERROR_BODY_BYTES = 4096;

export type KeyInput = Secret | string | undefined;

/** The key's plain value for one request header, or undefined for keyless endpoints. */
export function keyValue(key: KeyInput): string | undefined {
  if (key === undefined) return undefined;
  const value = typeof key === 'string' ? key : key.reveal();
  return value.trim() ? value.trim() : undefined;
}

/** Redacts the key (and known key shapes) out of a text bound for a message or log. */
export function redactKey(text: string, key: KeyInput): string {
  const value = keyValue(key);
  return redactSecrets(text, value ? [new Secret(value)] : []).text;
}

async function readPrefix(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    // A broken body leaves what arrived so far.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_BYTES));
}

function headerRecord(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of ['retry-after', 'request-id', 'x-request-id']) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Turns a non-2xx response into an `LlmFailure` with the provider's own message, redacted. */
export async function failureFromResponse(res: Response, provider: string, key: KeyInput): Promise<LlmFailure> {
  const raw = await readPrefix(res);
  // The code is decided on the whole body (Google's quotaId, quota wording); the message
  // carries only the provider's own short message.
  return failureFromHttp({
    status: res.status,
    provider,
    headers: headerRecord(res.headers),
    bodyText: redactKey(raw, key),
    detail: redactKey(providerMessage(raw), key),
  });
}

/** Maps anything `fetch` or a body read threw: abort, timeout, no connection, or a passthrough. */
export function failureFromThrown(error: unknown, provider: string, key: KeyInput, signal?: AbortSignal): LlmFailure {
  if (error instanceof LlmFailure) return error;
  const name = error instanceof Error ? error.name : '';
  const message = redactKey(error instanceof Error ? error.message : String(error), key);
  if (name === 'TimeoutError') {
    return new LlmFailure({ code: 'TIMEOUT', provider, message: `${provider} did not answer in time` });
  }
  if (signal?.aborted || name === 'AbortError') {
    return new LlmFailure({ code: 'ABORTED', provider, message: 'request aborted' });
  }
  if (error instanceof TypeError) {
    return new LlmFailure({ code: 'NETWORK', provider, message: `could not reach ${provider}: ${message}` });
  }
  return new LlmFailure({ code: 'UNKNOWN', provider, message });
}

export function bearerHeaders(key: KeyInput): Record<string, string> {
  const value = keyValue(key);
  return value ? { Authorization: `Bearer ${value}` } : {};
}
