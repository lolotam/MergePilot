import { createHash } from 'node:crypto';

export interface CompletionBot {
  slot: number;
  originalRunId: string;
  provider: 'openai' | 'anthropic';
  model: string;
  effort: string;
  skillDigest: string;
  contextDigest: string;
}
/** A trusted boundary must authenticate this context; these types do not do that. */
export interface CompletionIdentity {
  parentReceiptId: string;
  head: string;
  configHash: string;
  blobSha: string;
  rawSha256: string;
  byteLength: number;
  lineCount: number;
  bots: readonly CompletionBot[];
}
export interface CompletionChunk {
  id: number;
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  sha256: string;
}
export interface CompletionManifest {
  version: 1;
  profileHash: string;
  identity: CompletionIdentity;
  identityHash: string;
  chunks: readonly CompletionChunk[];
  manifestHash: string;
}
export interface CoverageAck {
  eventId: string;
  attemptId: string;
  botRunId: string;
  identityHash: string;
  profileHash: string;
  manifestHash: string;
  kind: 'range' | 'synthesis';
  chunkId?: number;
  start?: number;
  end?: number;
  sha256: string;
  material: 'full' | 'redacted' | 'unknown';
}
export type CompletionRefusal = 'invalid_context' | 'stale_context' | 'input_too_large' |
  'invalid_utf8' | 'blob_mismatch' | 'invalid_ack' | 'conflicting_ack';
export type CompletionResult<T> = { ok: true; value: T } | { ok: false; reason: CompletionRefusal };
export const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function identityHash(identity: CompletionIdentity): string {
  return digest(JSON.stringify({ parent: identity.parentReceiptId, head: identity.head,
    config: identity.configHash, blob: identity.blobSha, raw: identity.rawSha256,
    bytes: identity.byteLength, lines: identity.lineCount,
    bots: [...identity.bots].sort((a, b) => a.slot - b.slot).map((bot) => [bot.slot,
      bot.originalRunId, bot.provider, bot.model, bot.effort, bot.skillDigest, bot.contextDigest]) }));
}
export function validIdentity(identity: CompletionIdentity): boolean {
  if (typeof identity !== 'object' || identity === null || !Array.isArray(identity.bots) || identity.bots.length !== 4 ||
    ![identity.parentReceiptId, identity.head, identity.configHash, identity.blobSha, identity.rawSha256]
      .every((field) => typeof field === 'string') ||
    identity.bots.some((bot: CompletionBot) => typeof bot !== 'object' || bot === null ||
      ![bot.originalRunId, bot.provider, bot.model, bot.effort, bot.skillDigest, bot.contextDigest]
        .every((field) => typeof field === 'string'))) return false;
  return /^[0-9]{1,20}$/.test(identity.parentReceiptId) && SHA1.test(identity.head) &&
    /^[a-f0-9]{12}$/.test(identity.configHash) && SHA1.test(identity.blobSha) &&
    SHA256.test(identity.rawSha256) && Number.isSafeInteger(identity.byteLength) &&
    identity.byteLength > 0 && identity.byteLength <= 1048576 &&
    Number.isSafeInteger(identity.lineCount) && identity.lineCount > 0 &&
    identity.lineCount <= identity.byteLength && identity.bots.length === 4 &&
    new Set(identity.bots.map((bot) => bot.originalRunId)).size === 4 &&
    new Set(identity.bots.map((bot) => bot.slot)).size === 4 && identity.bots.every((bot) =>
      Number.isInteger(bot.slot) && bot.slot >= 1 && bot.slot <= 4 && UUID.test(bot.originalRunId) &&
      ['openai', 'anthropic'].includes(bot.provider) && bot.model.length > 0 && bot.model.length <= 128 &&
      bot.effort.length > 0 && bot.effort.length <= 32 && SHA256.test(bot.skillDigest) && SHA256.test(bot.contextDigest));
}
export function currentContext(manifest: CompletionManifest, current: CompletionIdentity): boolean {
  return validIdentity(current) && manifest.identityHash === identityHash(current) &&
    manifest.identityHash === identityHash(manifest.identity);
}
