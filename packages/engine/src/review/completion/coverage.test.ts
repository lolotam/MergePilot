import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompletionManifest } from './manifest.js';
import { digest, type CompletionIdentity, type CoverageAck } from './protocol.js';
import { applyCoverageAcknowledgment, completionAddendumStatus, emptyCompletionCoverage,
  type CompletionCoverage } from './coverage.js';

function fixture() {
  const bytes = Buffer.from('fake line\n'.repeat(1100));
  const identity: CompletionIdentity = { parentReceiptId: '1', head: '1'.repeat(40), configHash: 'a'.repeat(12),
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    rawSha256: digest(bytes), byteLength: bytes.length, lineCount: 1100,
    bots: Array.from({ length: 4 }, (_, index) => ({ slot: index + 1,
      originalRunId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      provider: 'openai', model: 'fake', effort: 'high', skillDigest: digest('skill'), contextDigest: digest('context') })) };
  const result = createCompletionManifest(bytes, identity, digest('profile'));
  if (!result.ok) throw new Error('Synthetic manifest refused');
  const manifest = result.value;
  const ack = (bot: number, chunk: number): CoverageAck => ({ eventId: `evt-${bot}-${chunk}`, attemptId: `call-${bot}-${chunk}`,
    botRunId: identity.bots[bot]!.originalRunId, identityHash: manifest.identityHash,
    profileHash: manifest.profileHash, manifestHash: manifest.manifestHash, kind: 'range',
    chunkId: chunk, start: manifest.chunks[chunk]!.start, end: manifest.chunks[chunk]!.end,
    sha256: manifest.chunks[chunk]!.sha256, material: 'full' });
  const synthesis = (bot: number): CoverageAck => ({ eventId: `synth-${bot}`, attemptId: `synth-call-${bot}`,
    botRunId: identity.bots[bot]!.originalRunId, identityHash: manifest.identityHash,
    profileHash: manifest.profileHash, manifestHash: manifest.manifestHash, kind: 'synthesis',
    sha256: manifest.manifestHash, material: 'full' });
  const apply = (state: CompletionCoverage, acknowledgment: CoverageAck) => {
    const next = applyCoverageAcknowledgment(manifest, state, identity, acknowledgment);
    if (!next.ok) throw new Error(`Synthetic acknowledgment refused: ${next.reason}`);
    return next.value;
  };
  return { manifest, identity, ack, synthesis, apply, empty: emptyCompletionCoverage(manifest) };
}
describe('offline per-original-bot coverage bookkeeping, never authenticated review', () => {
  it('requires every byte for each of four bots and separate full-file synthesis', () => {
    const f = fixture();
    let state = f.empty;
    for (let bot = 0; bot < 4; bot++) for (const chunk of [...f.manifest.chunks].reverse()) state = f.apply(state, f.ack(bot, chunk.id));
    expect(completionAddendumStatus(f.manifest, state, f.identity).status).toBe('partial');
    for (let bot = 0; bot < 3; bot++) state = f.apply(state, f.synthesis(bot));
    expect(completionAddendumStatus(f.manifest, state, f.identity).status).toBe('partial');
    state = f.apply(state, f.synthesis(3));
    expect(completionAddendumStatus(f.manifest, state, f.identity)).toMatchObject({
      status: 'complete', scope: 'completion-addendum-only', parentUnchanged: true });
    expect(f.identity.parentReceiptId).toBe('1');
  });
  it('reports exact missing ranges independently and rejects premature synthesis', () => {
    const f = fixture();
    const state = f.apply(f.empty, f.ack(0, 1));
    const status = completionAddendumStatus(f.manifest, state, f.identity);
    expect(status.bots[0]!.missing).toEqual([expect.objectContaining({ start: 0, end: f.manifest.chunks[0]!.end })]);
    expect(status.bots.slice(1).every((bot) => bot.missing.length === 2)).toBe(true);
    expect(applyCoverageAcknowledgment(f.manifest, state, f.identity, f.synthesis(0)))
      .toEqual({ ok: false, reason: 'invalid_ack' });
  });
  it('deduplicates exact event replay and never credits a duplicate range twice', () => {
    const f = fixture();
    const once = f.apply(f.empty, f.ack(0, 0));
    expect(f.apply(once, f.ack(0, 0))).toBe(once);
    const twice = f.apply(once, { ...f.ack(0, 0), eventId: 'new-event-same-range' });
    expect(completionAddendumStatus(f.manifest, twice, f.identity).bots[0]!.missing).toHaveLength(1);
    expect(f.empty.acknowledgments).toEqual([]);
  });
  it('retains a conflicting duplicate as partial rather than overwriting its history', () => {
    const f = fixture();
    const once = f.apply(f.empty, f.ack(0, 0));
    const conflict = f.apply(once, { ...f.ack(0, 0), sha256: digest('wrong') });
    expect(conflict.acknowledgments).toEqual(once.acknowledgments);
    expect(completionAddendumStatus(f.manifest, conflict, f.identity)).toMatchObject({
      status: 'partial', reasons: ['conflicting_ack'] });
  });
  it.each<Partial<CoverageAck>>([{ material: 'unknown' }, { material: 'redacted' }, { start: 1 },
    { end: 1 }, { sha256: digest('wrong') }, { botRunId: 'current-bot-not-original' },
    { identityHash: digest('wrong') }, { profileHash: digest('wrong') }, { manifestHash: digest('wrong') }])(
    'never credits unknown/redacted/wrong identity or range (case %#)', (change) => {
      const f = fixture();
      expect(applyCoverageAcknowledgment(f.manifest, f.empty, f.identity, { ...f.ack(0, 0), ...change }))
        .toEqual({ ok: false, reason: 'invalid_ack' });
      expect(completionAddendumStatus(f.manifest, f.empty, f.identity).status).toBe('partial');
    });
  it('invalidates all old coverage under a changed current head/config', () => {
    const f = fixture();
    const state = f.apply(f.empty, f.ack(0, 0));
    for (const current of [{ ...f.identity, head: '2'.repeat(40) }, { ...f.identity, configHash: 'b'.repeat(12) }]) {
      expect(applyCoverageAcknowledgment(f.manifest, state, current, f.ack(0, 1))).toEqual({ ok: false, reason: 'stale_context' });
      expect(completionAddendumStatus(f.manifest, state, current).bots.every((bot) => bot.missing.length === 2)).toBe(true);
    }
  });
  it('does not trust an imported premature synthesis record as complete', () => {
    const f = fixture();
    const corrupt = { ...f.empty, acknowledgments: [f.synthesis(0), f.ack(0, 0), f.ack(0, 1)] };
    expect(completionAddendumStatus(f.manifest, corrupt, f.identity)).toMatchObject({ status: 'partial', reasons: ['invalid_ack'] });
  });
  it('rejects duplicate event IDs in an otherwise fully covered restored snapshot', () => {
    const f = fixture();
    let state = f.empty;
    for (let bot = 0; bot < 4; bot++) {
      for (const chunk of f.manifest.chunks) state = f.apply(state, f.ack(bot, chunk.id));
      state = f.apply(state, f.synthesis(bot));
    }
    const corrupt = { ...state, acknowledgments: state.acknowledgments.map((ack) => ({ ...ack, eventId: 'same-event' })) };
    expect(completionAddendumStatus(f.manifest, corrupt, f.identity)).toMatchObject({ status: 'partial', reasons: ['invalid_ack'] });
    expect(applyCoverageAcknowledgment(f.manifest, corrupt, f.identity, f.ack(0, 0)))
      .toEqual({ ok: false, reason: 'invalid_ack' });
  });
  it('retains different conflict fingerprints once and never advances on exact conflict replay', () => {
    const f = fixture();
    const once = f.apply(f.empty, f.ack(0, 0));
    const bad = { ...f.ack(0, 0), sha256: digest('wrong') };
    const conflict = f.apply(once, bad);
    expect(f.apply(conflict, bad)).toBe(conflict);
    const different = f.apply(conflict, { ...bad, material: 'unknown' });
    expect(different.conflicts).toHaveLength(2);
    expect(different.revision).toBe(conflict.revision + 1);
    expect(different.acknowledgments).toEqual(once.acknowledgments);
    const restored: CompletionCoverage = JSON.parse(JSON.stringify(different));
    expect(f.apply(restored, bad)).toBe(restored);
    expect(completionAddendumStatus(f.manifest, restored, f.identity)).toMatchObject({ status: 'partial', reasons: ['conflicting_ack'] });
  });
  it('refuses incoherent restored revision/conflict envelopes instead of inventing history', () => {
    const f = fixture();
    const once = f.apply(f.empty, f.ack(0, 0));
    for (const state of [{ ...once, revision: 0 }, { ...once, revision: Number.NaN }]) {
      expect(completionAddendumStatus(f.manifest, state, f.identity).status).toBe('partial');
      expect(applyCoverageAcknowledgment(f.manifest, state, f.identity, f.ack(0, 1)))
        .toEqual({ ok: false, reason: 'invalid_ack' });
    }
  });
  it('keeps exact replay possible at the shared event bound but refuses a new conflict without dropping history', () => {
    const f = fixture();
    const once = f.apply(f.empty, f.ack(0, 0));
    const bad = { ...f.ack(0, 0), sha256: digest('wrong') };
    const conflict = f.apply(once, bad);
    const first = conflict.conflicts[0]!;
    const full: CompletionCoverage = { ...conflict, revision: 8192,
      conflicts: [first, ...Array.from({ length: 8190 }, (_, index) => ({ ...first, hash: digest(`bounded-${index}`) }))] };
    expect(f.apply(full, bad)).toBe(full);
    expect(applyCoverageAcknowledgment(f.manifest, full, f.identity, { ...bad, sha256: digest('new conflict') }))
      .toEqual({ ok: false, reason: 'input_too_large' });
    expect(full.conflicts).toHaveLength(8191);
    expect(completionAddendumStatus(f.manifest, full, f.identity).status).toBe('partial');
    const duplicate = { ...conflict, revision: 3, conflicts: [first, first] };
    expect(completionAddendumStatus(f.manifest, duplicate, f.identity).reasons).toContain('invalid_ack');
  });
});
