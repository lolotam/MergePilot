import { currentContext, digest, type CompletionIdentity, type CompletionManifest,
  type CompletionResult, type CoverageAck } from './protocol.js';

export interface CompletionCoverage {
  manifestHash: string;
  revision: number;
  acknowledgments: readonly CoverageAck[];
  conflicts: readonly string[];
}
export function emptyCompletionCoverage(manifest: CompletionManifest): CompletionCoverage {
  return { manifestHash: manifest.manifestHash, revision: 0, acknowledgments: [], conflicts: [] };
}
function acknowledgmentHash(ack: CoverageAck): string {
  return digest(JSON.stringify([ack.attemptId, ack.botRunId, ack.identityHash, ack.profileHash,
    ack.manifestHash, ack.kind, ack.chunkId ?? null, ack.start ?? null, ack.end ?? null, ack.sha256, ack.material]));
}
function validAck(manifest: CompletionManifest, ack: CoverageAck): boolean {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(ack.eventId) || !/^[a-zA-Z0-9:_-]{1,128}$/.test(ack.attemptId) ||
    !manifest.identity.bots.some((bot) => bot.originalRunId === ack.botRunId) ||
    ack.identityHash !== manifest.identityHash || ack.profileHash !== manifest.profileHash ||
    ack.manifestHash !== manifest.manifestHash || ack.material !== 'full') return false;
  if (ack.kind === 'synthesis') return ack.sha256 === manifest.manifestHash &&
    ack.chunkId === undefined && ack.start === undefined && ack.end === undefined;
  if (ack.kind !== 'range' || !Number.isInteger(ack.chunkId)) return false;
  const chunk = manifest.chunks.find((entry) => entry.id === ack.chunkId);
  return chunk !== undefined && ack.start === chunk.start && ack.end === chunk.end && ack.sha256 === chunk.sha256;
}
function rangeIds(manifest: CompletionManifest, acks: readonly CoverageAck[], runId: string): Set<number> {
  return new Set(acks.filter((ack) => ack.botRunId === runId && ack.kind === 'range' && validAck(manifest, ack))
    .flatMap((ack) => ack.chunkId === undefined ? [] : [ack.chunkId]));
}
/** Records only protocol assertions, not authenticated model reading or historical coverage. */
export function applyCoverageAcknowledgment(
  manifest: CompletionManifest,
  state: CompletionCoverage,
  current: CompletionIdentity,
  ack: CoverageAck,
): CompletionResult<CompletionCoverage> {
  if (!currentContext(manifest, current) || state.manifestHash !== manifest.manifestHash) {
    return { ok: false, reason: 'stale_context' };
  }
  const previous = state.acknowledgments.find((entry) => entry.eventId === ack.eventId);
  if (previous) {
    if (acknowledgmentHash(previous) === acknowledgmentHash(ack)) return { ok: true, value: state };
    const conflicts = [...new Set([...state.conflicts, ack.eventId])];
    return { ok: true, value: { ...state, revision: state.revision + 1, conflicts } };
  }
  if (!validAck(manifest, ack)) return { ok: false, reason: 'invalid_ack' };
  if (state.acknowledgments.length >= 8192) return { ok: false, reason: 'input_too_large' };
  const logical = state.acknowledgments.find((entry) => entry.botRunId === ack.botRunId &&
    entry.attemptId === ack.attemptId && entry.kind === ack.kind && entry.chunkId === ack.chunkId);
  if (logical && acknowledgmentHash(logical) !== acknowledgmentHash(ack)) {
    return { ok: true, value: { ...state, revision: state.revision + 1,
      conflicts: [...new Set([...state.conflicts, ack.eventId])] } };
  }
  if (ack.kind === 'synthesis' && rangeIds(manifest, state.acknowledgments, ack.botRunId).size !== manifest.chunks.length) {
    return { ok: false, reason: 'invalid_ack' };
  }
  return { ok: true, value: { ...state, revision: state.revision + 1,
    acknowledgments: [...state.acknowledgments, Object.freeze({ ...ack })] } };
}
export function completionAddendumStatus(
  manifest: CompletionManifest,
  state: CompletionCoverage,
  current: CompletionIdentity,
) {
  const stale = !currentContext(manifest, current) || state.manifestHash !== manifest.manifestHash;
  let invalid = state.acknowledgments.some((ack) => !validAck(manifest, ack));
  const bots = manifest.identity.bots.map((bot) => {
    const covered = new Set<number>();
    let synthesis = false;
    if (!stale) for (const ack of state.acknowledgments.filter((entry) => entry.botRunId === bot.originalRunId)) {
      if (!validAck(manifest, ack)) continue;
      if (ack.kind === 'range' && ack.chunkId !== undefined) covered.add(ack.chunkId);
      if (ack.kind === 'synthesis') {
        if (covered.size === manifest.chunks.length) synthesis = true;
        else invalid = true;
      }
    }
    return { originalRunId: bot.originalRunId, synthesis,
      missing: manifest.chunks.filter((chunk) => !covered.has(chunk.id)).map((chunk) => ({
        start: chunk.start, end: chunk.end, startLine: chunk.startLine, endLine: chunk.endLine })) };
  });
  const complete = !stale && !invalid && state.conflicts.length === 0 &&
    bots.every((bot) => bot.synthesis && bot.missing.length === 0);
  return { status: complete ? 'complete' as const : 'partial' as const,
    scope: 'completion-addendum-only' as const, parentUnchanged: true as const, bots,
    reasons: [...(stale ? ['stale_context'] : []), ...(invalid ? ['invalid_ack'] : []),
      ...(state.conflicts.length ? ['conflicting_ack'] : [])] };
}
