import { currentContext, digest, SHA256, type CompletionIdentity, type CompletionManifest,
  type CompletionResult, type CoverageAck } from './protocol.js';

export interface CompletionCoverage {
  manifestHash: string;
  revision: number;
  acknowledgments: readonly CoverageAck[];
  conflicts: ReadonlyArray<{ eventId: string; againstEventId: string; hash: string }>;
}
export function emptyCompletionCoverage(manifest: CompletionManifest): CompletionCoverage {
  return { manifestHash: manifest.manifestHash, revision: 0, acknowledgments: [], conflicts: [] };
}
function acknowledgmentHash(ack: CoverageAck): string {
  return digest(JSON.stringify([ack.attemptId, ack.botRunId, ack.identityHash, ack.profileHash,
    ack.manifestHash, ack.kind, ack.chunkId ?? null, ack.start ?? null, ack.end ?? null, ack.sha256, ack.material]));
}
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
function acknowledgmentEnvelope(ack: CoverageAck): boolean {
  return ack !== null && typeof ack === 'object' && identifier(ack.eventId) && identifier(ack.attemptId) &&
    identifier(ack.botRunId) && [ack.identityHash, ack.profileHash, ack.manifestHash, ack.sha256]
      .every((hash) => typeof hash === 'string' && SHA256.test(hash)) &&
    ['range', 'synthesis'].includes(ack.kind) && ['full', 'redacted', 'unknown'].includes(ack.material) &&
    [ack.chunkId, ack.start, ack.end].every((n) => n === undefined || (Number.isSafeInteger(n) && n >= 0 && n <= 1048576));
}
function validAck(manifest: CompletionManifest, ack: CoverageAck): boolean {
  if (!acknowledgmentEnvelope(ack) ||
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
/** Restore validates internal history only; coherent unsigned assertions still are not review proof. */
function consistentCoverage(manifest: CompletionManifest, state: CompletionCoverage): boolean {
  if (!state || !Array.isArray(state.acknowledgments) || !Array.isArray(state.conflicts) ||
    !Number.isSafeInteger(state.revision) || state.revision !== state.acknowledgments.length + state.conflicts.length ||
    state.revision > 8192) return false;
  const ids = new Set<string>();
  const prior: CoverageAck[] = [];
  for (const ack of state.acknowledgments) {
    if (!validAck(manifest, ack) || ids.has(ack.eventId) || (ack.kind === 'synthesis' &&
      rangeIds(manifest, prior, ack.botRunId).size !== manifest.chunks.length)) return false;
    ids.add(ack.eventId);
    prior.push(ack);
  }
  const observations = new Set<string>();
  for (const conflict of state.conflicts) {
    if (!conflict || !identifier(conflict.eventId) || !identifier(conflict.againstEventId) ||
      typeof conflict.hash !== 'string' || !SHA256.test(conflict.hash)) return false;
    const against = state.acknowledgments.find((ack) => ack.eventId === conflict.againstEventId);
    const fingerprint = `${conflict.eventId}:${conflict.hash}`;
    if (!against || acknowledgmentHash(against) === conflict.hash || observations.has(fingerprint)) return false;
    observations.add(fingerprint);
  }
  return true;
}
function conflictingAck(state: CompletionCoverage, ack: CoverageAck, against: CoverageAck): CompletionResult<CompletionCoverage> {
  const hash = acknowledgmentHash(ack);
  if (state.conflicts.some((entry) => entry.eventId === ack.eventId && entry.hash === hash)) return { ok: true, value: state };
  if (state.acknowledgments.length + state.conflicts.length >= 8192) return { ok: false, reason: 'input_too_large' };
  return { ok: true, value: { ...state, revision: state.revision + 1,
    conflicts: [...state.conflicts, { eventId: ack.eventId, againstEventId: against.eventId, hash }] } };
}
/** Records only protocol assertions, not authenticated model reading or historical coverage. */
export function applyCoverageAcknowledgment(
  manifest: CompletionManifest,
  state: CompletionCoverage,
  current: CompletionIdentity,
  ack: CoverageAck,
): CompletionResult<CompletionCoverage> {
  if (!consistentCoverage(manifest, state) || !acknowledgmentEnvelope(ack)) return { ok: false, reason: 'invalid_ack' };
  if (!currentContext(manifest, current) || state.manifestHash !== manifest.manifestHash) {
    return { ok: false, reason: 'stale_context' };
  }
  const previous = state.acknowledgments.find((entry) => entry.eventId === ack.eventId);
  if (previous) {
    if (acknowledgmentHash(previous) === acknowledgmentHash(ack)) return { ok: true, value: state };
    return conflictingAck(state, ack, previous);
  }
  const priorConflict = state.conflicts.find((entry) => entry.eventId === ack.eventId);
  if (priorConflict) {
    const against = state.acknowledgments.find((entry) => entry.eventId === priorConflict.againstEventId)!;
    return acknowledgmentHash(ack) === acknowledgmentHash(against) ? { ok: false, reason: 'conflicting_ack' }
      : conflictingAck(state, ack, against);
  }
  if (!validAck(manifest, ack)) return { ok: false, reason: 'invalid_ack' };
  if (state.acknowledgments.length + state.conflicts.length >= 8192) return { ok: false, reason: 'input_too_large' };
  const logical = state.acknowledgments.find((entry) => entry.botRunId === ack.botRunId &&
    entry.attemptId === ack.attemptId && entry.kind === ack.kind && entry.chunkId === ack.chunkId);
  if (logical && acknowledgmentHash(logical) !== acknowledgmentHash(ack)) {
    return conflictingAck(state, ack, logical);
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
  const stale = !currentContext(manifest, current) || state?.manifestHash !== manifest.manifestHash;
  let invalid = !consistentCoverage(manifest, state);
  const hasConflicts = Array.isArray(state?.conflicts) && state.conflicts.length > 0;
  const bots = manifest.identity.bots.map((bot) => {
    const covered = new Set<number>();
    let synthesis = false;
    if (!stale && !invalid) for (const ack of state.acknowledgments.filter((entry) => entry.botRunId === bot.originalRunId)) {
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
  const complete = !stale && !invalid && !hasConflicts &&
    bots.every((bot) => bot.synthesis && bot.missing.length === 0);
  return { status: complete ? 'complete' as const : 'partial' as const,
    scope: 'completion-addendum-only' as const, parentUnchanged: true as const, bots,
    reasons: [...(stale ? ['stale_context'] : []), ...(invalid ? ['invalid_ack'] : []),
      ...(hasConflicts ? ['conflicting_ack'] : [])] };
}
