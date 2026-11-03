import { createHash } from 'node:crypto';
import { digest, identityHash, SHA256, validIdentity, type CompletionChunk,
  type CompletionIdentity, type CompletionManifest, type CompletionResult } from './protocol.js';

function lineCount(bytes: Uint8Array): number {
  let count = bytes[bytes.length - 1] === 10 ? 0 : 1;
  for (const byte of bytes) if (byte === 10) count++;
  return count;
}
/** Byte ranges are authoritative; line/column endpoints are exclusive UTF8-byte cursors. */
function partition(bytes: Uint8Array): CompletionChunk[] {
  const chunks: CompletionChunk[] = [];
  let start = 0, line = 1, column = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 65536, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    let breaks = 0;
    for (let index = start; index < end; index++) {
      if (bytes[index] === 10 && ++breaks === 1024) { end = index + 1; break; }
    }
    const startLine = line, startColumn = column;
    for (let index = start; index < end; index++) {
      if (bytes[index] === 10) { line++; column = 0; }
      else column++;
    }
    chunks.push(Object.freeze({ id: chunks.length, start, end, startLine, startColumn,
      endLine: line, endColumn: column, sha256: digest(bytes.subarray(start, end)) }));
    start = end;
  }
  return chunks;
}
export function createCompletionManifest(
  input: Uint8Array,
  identity: CompletionIdentity,
  profileHash: string,
): CompletionResult<CompletionManifest> {
  if (!validIdentity(identity) || !SHA256.test(profileHash)) return { ok: false, reason: 'invalid_context' };
  if (input.byteLength > 1048576) return { ok: false, reason: 'input_too_large' };
  const bytes = Buffer.from(input);
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, reason: 'invalid_utf8' }; }
  const gitSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== identity.byteLength || lineCount(bytes) !== identity.lineCount ||
    digest(bytes) !== identity.rawSha256 || gitSha !== identity.blobSha) return { ok: false, reason: 'blob_mismatch' };
  const chunks = partition(bytes);
  if (chunks.length > 1024) return { ok: false, reason: 'input_too_large' };
  const cloned = structuredClone(identity);
  for (const bot of cloned.bots) Object.freeze(bot);
  Object.freeze(cloned.bots);
  Object.freeze(cloned);
  const context = identityHash(cloned);
  const manifestHash = digest(JSON.stringify({ version: 1, context, profileHash, chunks }));
  return { ok: true, value: Object.freeze({ version: 1, profileHash,
    identity: cloned, identityHash: context, chunks: Object.freeze(chunks), manifestHash }) };
}
