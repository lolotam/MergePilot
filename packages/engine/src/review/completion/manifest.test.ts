import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompletionManifest } from './manifest.js';
import { currentContext, digest, type CompletionIdentity } from './protocol.js';

function identity(bytes: Buffer): CompletionIdentity {
  return { parentReceiptId: '1', head: '1'.repeat(40), configHash: 'a'.repeat(12),
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    rawSha256: digest(bytes), byteLength: bytes.length,
    lineCount: [...bytes].filter((byte) => byte === 10).length + (bytes.at(-1) === 10 ? 0 : 1),
    bots: Array.from({ length: 4 }, (_, index) => ({ slot: index + 1,
      originalRunId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      provider: index === 1 ? 'anthropic' : 'openai', model: index === 1 ? 'claude-opus-5-5' : 'gpt-5.6-sol',
      effort: 'high', skillDigest: digest(`fake-skill-${index}`), contextDigest: digest(`fake-context-${index}`) })) };
}
describe('offline completion manifest: synthetic blobs, no actual #785 coverage', () => {
  it.each(['مرحبا\r\n😀\n'.repeat(9000), '😀'.repeat(40000), 'x\n'.repeat(40000)])(
    'partitions exact UTF8 bytes and CRLF without omission/normalization (case %#)', (text) => {
      const bytes = Buffer.from(text);
      const target = identity(bytes);
      const result = createCompletionManifest(bytes, target, digest('profile'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Manifest refused synthetic fixture');
      const slices: Buffer[] = [];
      let cursor = 0;
      for (const chunk of result.value.chunks) {
        expect(chunk.start).toBe(cursor);
        expect(chunk.end).toBeGreaterThan(chunk.start);
        expect(chunk.end - chunk.start).toBeLessThanOrEqual(65536);
        const slice = bytes.subarray(chunk.start, chunk.end);
        expect(() => new TextDecoder('utf-8', { fatal: true }).decode(slice)).not.toThrow();
        expect([...slice].filter((byte) => byte === 10).length).toBeLessThanOrEqual(1024);
        expect(digest(slice)).toBe(chunk.sha256);
        slices.push(slice);
        cursor = chunk.end;
      }
      expect(cursor).toBe(bytes.length);
      expect(Buffer.concat(slices)).toEqual(bytes);
      expect(createCompletionManifest(bytes, target, digest('profile'))).toEqual(result);
    });
  it('detaches and freezes context/chunks rather than trusting subsequent caller mutation', () => {
    const bytes = Buffer.from('fake\r\nsource\n');
    const target = identity(bytes);
    const result = createCompletionManifest(bytes, target, digest('profile'));
    if (!result.ok) throw new Error('Fixture refused');
    target.bots[0]!.model = 'changed';
    bytes[0] = 1;
    expect(result.value.identity.bots[0]!.model).toBe('gpt-5.6-sol');
    expect(Object.isFrozen(result.value.identity.bots[0])).toBe(true);
    expect(Object.isFrozen(result.value.chunks)).toBe(true);
    expect(currentContext(result.value, target)).toBe(false);
  });
  it.each(['parentReceiptId', 'head', 'configHash', 'blobSha', 'rawSha256'] as const)(
    'binds immutable %s rather than using current defaults', (field) => {
      const bytes = Buffer.from('fake\n');
      const target = identity(bytes);
      const result = createCompletionManifest(bytes, target, digest('profile'));
      if (!result.ok) throw new Error('Fixture refused');
      const changed = { ...target, [field]: field === 'parentReceiptId' ? '2' : 'b'.repeat(target[field].length) };
      expect(currentContext(result.value, changed)).toBe(false);
    });
  it.each(['model', 'effort', 'skillDigest', 'contextDigest'] as const)('binds original bot %s', (field) => {
    const bytes = Buffer.from('fake\n');
    const target = identity(bytes);
    const result = createCompletionManifest(bytes, target, digest('profile'));
    if (!result.ok) throw new Error('Fixture refused');
    const changed = structuredClone(target);
    changed.bots[0]![field] = field.endsWith('Digest') ? digest('changed') : 'changed';
    expect(currentContext(result.value, changed)).toBe(false);
  });
  it('refuses wrong full blob identity, declared size and line coverage', () => {
    const bytes = Buffer.from('fake\n');
    for (const change of [{ blobSha: '0'.repeat(40) }, { rawSha256: '0'.repeat(64) },
      { byteLength: bytes.length + 1 }, { lineCount: 2 }]) {
      expect(createCompletionManifest(bytes, { ...identity(bytes), ...change }, digest('profile')))
        .toEqual({ ok: false, reason: 'blob_mismatch' });
    }
  });
  it('refuses invalid UTF8 and oversized material without returning any clipped manifest', () => {
    const invalid = Buffer.from([0xc3, 0x28]);
    expect(createCompletionManifest(invalid, identity(invalid), digest('profile')))
      .toEqual({ ok: false, reason: 'invalid_utf8' });
    const valid = identity(Buffer.from('x'));
    expect(createCompletionManifest(Buffer.alloc(1048577), valid, digest('profile')))
      .toEqual({ ok: false, reason: 'input_too_large' });
  });
  it('refuses duplicate original bot slots/run identities and malformed context', () => {
    const bytes = Buffer.from('x');
    const target = identity(bytes);
    expect(createCompletionManifest(bytes, { ...target, bots: [target.bots[0]!, ...target.bots.slice(0, 3)] }, digest('profile')))
      .toEqual({ ok: false, reason: 'invalid_context' });
    expect(createCompletionManifest(bytes, { ...target, parentReceiptId: '' }, digest('profile')))
      .toEqual({ ok: false, reason: 'invalid_context' });
  });
});
