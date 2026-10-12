/**
 * The judge key test: one tiny `noul` question to one provider (no fallback), answering like the
 * provider connection test. A wrong model id shows up as the provider's own redacted 4xx message.
 */
import type { Secret } from '../credentials/secret.js';
import { LlmFailure } from '../llm/failure.js';
import type { FetchLike } from '../providers/http.js';
import { callSystemOne } from './call.js';
import { judgeFailureCode } from './judge.js';
import { defaultJevModel, type JudgeProviderId } from './providers.js';
import { noul } from './questions.js';

export type JudgeConnectionResult =
  | { ok: true; ms: number; model: string }
  | { ok: false; ms: number; code: string; message: string };

export interface JudgeConnectionOptions {
  model?: string | undefined;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function testJudgeConnection(
  provider: JudgeProviderId,
  apiKey: Secret | string,
  options: JudgeConnectionOptions = {},
): Promise<JudgeConnectionResult> {
  const model = options.model ?? defaultJevModel(provider);
  const started = Date.now();
  try {
    const result = await callSystemOne({
      provider,
      model,
      apiKey,
      state: { value: 1 },
      questions: { ok: noul('Is `value` equal to 1?') },
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return { ok: true, ms: Date.now() - started, model: result.model };
  } catch (error) {
    const message = error instanceof LlmFailure || error instanceof Error ? error.message : 'judge test failed';
    return { ok: false, ms: Date.now() - started, code: judgeFailureCode(error), message };
  }
}
