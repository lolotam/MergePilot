import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompletionManifest } from './manifest.js';
import { digest, type CompletionIdentity } from './protocol.js';
import { createCompletionBudget, recordCompletionAttempt, reserveCompletionAttempt,
  type AttemptReservation, type BudgetResult, type CompletionBudget } from './budget.js';

function accepted(result: BudgetResult): CompletionBudget {
  if (!result.ok) throw new Error(`Synthetic budget refused: ${result.reason}`);
  return result.value;
}
function fixture(approved = true) {
  const bytes = Buffer.from('fake\n');
  const identity: CompletionIdentity = { parentReceiptId: '1', head: '1'.repeat(40), configHash: 'a'.repeat(12),
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    rawSha256: digest(bytes), byteLength: bytes.length, lineCount: 1,
    bots: Array.from({ length: 4 }, (_, index) => ({ slot: index + 1,
      originalRunId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      provider: 'openai', model: 'fake', effort: 'high', skillDigest: digest('skill'), contextDigest: digest('context') })) };
  const built = createCompletionManifest(bytes, identity, digest('profile'));
  if (!built.ok) throw new Error('Synthetic manifest refused');
  const manifest = built.value;
  const policy = { reference: digest('fake-owner-assertion'), bots: identity.bots.map((bot) => ({
    runId: bot.originalRunId, limits: { attempts: 3, input: 300, output: 150, costMicros: 30 },
    resource: { reference: digest('fake-resource-assertion'), provider: bot.provider, model: bot.model,
      maxInput: 100, maxOutput: 50, maxCostMicros: 10 } })) };
  const state = accepted(createCompletionBudget(manifest, 10000, approved ? policy : undefined));
  const request = (snapshot: CompletionBudget, id = 'attempt-1'): AttemptReservation => ({
    current: identity, expectedRevision: snapshot.revision, nowMs: 1000, id,
    runId: identity.bots[0]!.originalRunId, chunkId: 0, fence: 7, input: 100, output: 50, costMicros: 10 });
  const record = (snapshot: CompletionBudget, kind: 'dispatched' | 'unknown' | 'settled', attemptId = 'attempt-1') =>
    accepted(recordCompletionAttempt(snapshot, { id: `${attemptId}-${kind}`, attemptId,
      fence: 7, expectedRevision: snapshot.revision, kind }));
  return { manifest, identity, policy, state, request, record };
}
describe('offline completion lifetime budgets: fake assertions, zero real calls/spend', () => {
  it('defaults all four bots to zero calls/tokens/spend and no execution approval', () => {
    const f = fixture(false);
    expect(f.state.bots.every((bot) => Object.values(bot.limits).every((limit) => limit === 0))).toBe(true);
    expect(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)))
      .toEqual({ ok: false, reason: 'execution_not_approved' });
    expect(f.state.attempts).toEqual([]);
  });
  it('requires same-provider/model resource assertion and bounded serialized-input/output ceilings', () => {
    const f = fixture();
    for (const resource of [null, { ...f.policy.bots[0]!.resource, model: 'substitute' },
      { ...f.policy.bots[0]!.resource, maxInput: 99 }, { ...f.policy.bots[0]!.resource, maxOutput: 49 }]) {
      const state = structuredClone(f.state);
      state.bots[0]!.resource = resource;
      expect(reserveCompletionAttempt(state, f.manifest, f.request(state)))
        .toEqual({ ok: false, reason: 'provider_resource_unproven' });
      expect(state.bots[0]!.used.attempts).toBe(0);
    }
  });
  it('charges transport retries across restored snapshots instead of resetting on queue/worker retry', () => {
    const f = fixture();
    let state = f.state;
    for (const id of ['outer-1', 'queue-2', 'restart-3']) {
      state = accepted(reserveCompletionAttempt(structuredClone(state), f.manifest, f.request(state, id)));
      state = f.record(state, 'dispatched', id);
      state = f.record(state, 'unknown', id);
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
    expect(state.bots[0]!.used).toEqual({ attempts: 3, input: 300, output: 150, costMicros: 30 });
    expect(reserveCompletionAttempt(state, f.manifest, f.request(state, 'attempt-4')))
      .toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(f.state.bots[0]!.used.attempts).toBe(0);
  });
  it('keeps unknown usage fully charged even when the original late outcome becomes settled', () => {
    const f = fixture();
    const reserved = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    const unknown = f.record(f.record(reserved, 'dispatched'), 'unknown');
    const settled = f.record(unknown, 'settled');
    expect(settled.bots[0]!.used).toEqual(reserved.bots[0]!.used);
    expect(settled.attempts[0]!.events.map((event) => event.kind)).toEqual(['dispatched', 'unknown', 'settled']);
    expect(recordCompletionAttempt(unknown, { id: 'unsafe-release', attemptId: 'attempt-1', fence: 7,
      expectedRevision: unknown.revision, kind: 'not_dispatched', provenNeverDispatched: true }))
      .toEqual({ ok: false, reason: 'invalid_transition' });
  });
  it('releases only positively never-dispatched token/spend reservation once, preserving lifetime attempt count', () => {
    const f = fixture();
    const state = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    const event = { id: 'release', attemptId: 'attempt-1', fence: 7, expectedRevision: state.revision,
      kind: 'not_dispatched' as const, provenNeverDispatched: true };
    expect(recordCompletionAttempt(state, { ...event, provenNeverDispatched: false }))
      .toEqual({ ok: false, reason: 'invalid_transition' });
    const released = accepted(recordCompletionAttempt(state, event));
    expect(released.bots[0]!.used).toEqual({ attempts: 1, input: 0, output: 0, costMicros: 0 });
    expect(recordCompletionAttempt(released, event)).toEqual({ ok: true, value: released });
  });
  it('deduplicates reservation/event identities and refuses conflicting payload or stale fence/revision', () => {
    const f = fixture();
    const request = f.request(f.state);
    const once = accepted(reserveCompletionAttempt(f.state, f.manifest, request));
    expect(reserveCompletionAttempt(once, f.manifest, request)).toEqual({ ok: true, value: once, reservation: 'replayed' });
    expect(reserveCompletionAttempt(once, f.manifest, { ...request, output: 49 }))
      .toEqual({ ok: false, reason: 'conflicting_attempt' });
    expect(reserveCompletionAttempt(once, f.manifest, { ...request, id: 'another' }))
      .toEqual({ ok: false, reason: 'stale_revision' });
    expect(recordCompletionAttempt(once, { id: 'late', attemptId: request.id, fence: 6,
      expectedRevision: once.revision, kind: 'dispatched' })).toEqual({ ok: false, reason: 'conflicting_attempt' });
  });
  it('uses the immutable absolute deadline after resume, and checks current head/config before admission', () => {
    const f = fixture();
    for (const nowMs of [10000, 20000, Number.NaN, -1]) {
      expect(reserveCompletionAttempt(structuredClone(f.state), f.manifest, { ...f.request(f.state), nowMs }))
        .toEqual({ ok: false, reason: 'deadline' });
    }
    for (const current of [{ ...f.identity, head: '2'.repeat(40) }, { ...f.identity, configHash: 'b'.repeat(12) }]) {
      expect(reserveCompletionAttempt(f.state, f.manifest, { ...f.request(f.state), current }))
        .toEqual({ ok: false, reason: 'stale_context' });
    }
    expect(f.state.deadlineMs).toBe(10000);
  });
  it('refuses a counter reset against retained attempt history and malformed policy', () => {
    const f = fixture();
    const state = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    const corrupt = structuredClone(state);
    corrupt.bots[0]!.used.input = 0;
    expect(reserveCompletionAttempt(corrupt, f.manifest, f.request(corrupt, 'new')))
      .toEqual({ ok: false, reason: 'invalid_budget' });
    const malformed = structuredClone(f.policy);
    malformed.bots[0]!.limits.input = -1;
    expect(createCompletionBudget(f.manifest, 10000, malformed)).toEqual({ ok: false, reason: 'invalid_budget' });
  });
  it('distinguishes new bookkeeping from an immutable reserved replay', () => {
    const f = fixture();
    const created = reserveCompletionAttempt(f.state, f.manifest, f.request(f.state));
    expect(created).toMatchObject({ ok: true, reservation: 'created' });
    const state = accepted(created);
    expect(reserveCompletionAttempt(state, f.manifest, f.request(state)))
      .toEqual({ ok: true, value: state, reservation: 'replayed' });
    expect(state.bots[0]!.used).toEqual({ attempts: 1, input: 100, output: 50, costMicros: 10 });
  });
  it.each(['not_dispatched', 'dispatched', 'unknown', 'settled'] as const)('refuses reservation replay after %s', (status) => {
    const f = fixture();
    let state = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    if (status === 'not_dispatched') state = accepted(recordCompletionAttempt(state, {
      id: 'release', attemptId: 'attempt-1', fence: 7, expectedRevision: state.revision,
      kind: 'not_dispatched', provenNeverDispatched: true }));
    else {
      state = f.record(state, 'dispatched');
      if (status !== 'dispatched') state = f.record(state, 'unknown');
      if (status === 'settled') state = f.record(state, 'settled');
    }
    const before = structuredClone(state);
    expect(reserveCompletionAttempt(state, f.manifest, f.request(state))).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(state).toEqual(before);
  });
  it.each([{ input: 99 }, { output: 49 }, { costMicros: 9 }])('refuses a charge below its asserted worst case %j', (change) => {
    const f = fixture();
    expect(reserveCompletionAttempt(f.state, f.manifest, { ...f.request(f.state), ...change }))
      .toEqual({ ok: false, reason: 'provider_resource_unproven' });
  });
  it('rejects forged released state without retained legal proof/history', () => {
    const f = fixture();
    const state = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    state.attempts[0]!.status = 'not_dispatched';
    state.bots[0]!.used = { attempts: 1, input: 0, output: 0, costMicros: 0 };
    expect(reserveCompletionAttempt(state, f.manifest, f.request(state, 'new')))
      .toEqual({ ok: false, reason: 'invalid_budget' });
  });
  it('retains release proof and rejects semantic collisions across attempts or proof values', () => {
    const f = fixture();
    let state = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    state = accepted(reserveCompletionAttempt(state, f.manifest, f.request(state, 'attempt-2')));
    const event = { id: 'global-event', attemptId: 'attempt-1', fence: 7,
      expectedRevision: state.revision, kind: 'not_dispatched' as const, provenNeverDispatched: true };
    const released = accepted(recordCompletionAttempt(state, event));
    expect(released.attempts[0]!.events[0]).toMatchObject({ attemptId: 'attempt-1', fence: 7, provenNeverDispatched: true });
    expect(recordCompletionAttempt(released, { ...event, expectedRevision: released.revision, attemptId: 'attempt-2' }))
      .toEqual({ ok: false, reason: 'conflicting_attempt' });
    expect(recordCompletionAttempt(released, { ...event, provenNeverDispatched: false }))
      .toEqual({ ok: false, reason: 'conflicting_attempt' });
    Object.assign(released.attempts[0]!.events[0]!, { provenNeverDispatched: false });
    expect(reserveCompletionAttempt(released, f.manifest, f.request(released, 'new')))
      .toEqual({ ok: false, reason: 'invalid_budget' });
  });
  it('rejects restored global event collisions, wrong revision and changed charge ceilings', () => {
    const f = fixture();
    let state = accepted(reserveCompletionAttempt(f.state, f.manifest, f.request(f.state)));
    state = accepted(reserveCompletionAttempt(state, f.manifest, f.request(state, 'attempt-2')));
    state = f.record(f.record(state, 'dispatched'), 'dispatched', 'attempt-2');
    const duplicate = structuredClone(state);
    duplicate.attempts[1]!.events[0]!.id = duplicate.attempts[0]!.events[0]!.id;
    const wrongRevision = { ...state, revision: state.revision - 1 };
    const wrongCharge = structuredClone(state);
    wrongCharge.bots[0]!.resource!.maxOutput = 49;
    for (const corrupt of [duplicate, wrongRevision, wrongCharge]) {
      expect(reserveCompletionAttempt(corrupt, f.manifest, f.request(corrupt, 'new')))
        .toEqual({ ok: false, reason: 'invalid_budget' });
    }
  });
  it('never infers a zero charge from missing, negative or unknown cost ceilings', () => {
    const f = fixture();
    for (const maxCostMicros of [undefined, -1, Number.NaN]) {
      const state = structuredClone(f.state);
      Object.assign(state.bots[0]!.resource!, { maxCostMicros });
      expect(reserveCompletionAttempt(state, f.manifest, f.request(state)))
        .toEqual({ ok: false, reason: 'provider_resource_unproven' });
    }
  });
});
