import { currentContext, SHA256, type CompletionIdentity, type CompletionManifest } from './protocol.js';

export interface CompletionCharge { attempts: number; input: number; output: number; costMicros: number }
export interface ResourceAssertion {
  reference: string;
  provider: string;
  model: string;
  maxInput: number;
  maxOutput: number;
  maxCostMicros: number;
}
interface BotBudget {
  runId: string;
  limits: CompletionCharge;
  used: CompletionCharge;
  resource: ResourceAssertion | null;
}
interface BudgetAttempt {
  id: string;
  runId: string;
  chunkId: number | null;
  fence: number;
  charge: CompletionCharge;
  status: 'reserved' | 'dispatched' | 'unknown' | 'settled' | 'not_dispatched';
  events: BudgetEvent[];
}
interface BudgetEvent {
  id: string; attemptId: string; fence: number;
  kind: Exclude<BudgetAttempt['status'], 'reserved'>;
  provenNeverDispatched: boolean | null;
}
export interface CompletionBudget {
  version: 1;
  identityHash: string;
  profileHash: string;
  deadlineMs: number;
  revision: number;
  approvalReference: string | null;
  bots: BotBudget[];
  attempts: BudgetAttempt[];
}
type BudgetRefusal = 'invalid_budget' | 'stale_context' | 'stale_revision' | 'deadline' |
  'execution_not_approved' | 'provider_resource_unproven' | 'budget_exhausted' |
  'conflicting_attempt' | 'invalid_transition';
export type BudgetResult = { ok: true; value: CompletionBudget } | { ok: false; reason: BudgetRefusal };
export type ReservationResult = { ok: true; value: CompletionBudget; reservation: 'created' | 'replayed' } |
  { ok: false; reason: BudgetRefusal };
const zero = (): CompletionCharge => ({ attempts: 0, input: 0, output: 0, costMicros: 0 });
const keys = ['attempts', 'input', 'output', 'costMicros'] as const;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
function chargeValid(charge: CompletionCharge): boolean {
  return charge !== null && typeof charge === 'object' &&
    keys.every((key) => Number.isSafeInteger(charge[key]) && charge[key] >= 0);
}
function resourceValid(resource: ResourceAssertion | null): resource is ResourceAssertion {
  return resource !== null && typeof resource === 'object' && typeof resource.reference === 'string' && SHA256.test(resource.reference) &&
    typeof resource.provider === 'string' && typeof resource.model === 'string' &&
    [resource.maxInput, resource.maxOutput, resource.maxCostMicros].every((n) => Number.isSafeInteger(n) && n >= 0);
}
function allowedTransition(status: BudgetAttempt['status'], event: BudgetEvent): boolean {
  if (event.kind === 'not_dispatched') return status === 'reserved' && event.provenNeverDispatched === true;
  if (event.provenNeverDispatched !== null) return false;
  return (status === 'reserved' && event.kind === 'dispatched') ||
    (status === 'dispatched' && ['unknown', 'settled'].includes(event.kind)) ||
    (status === 'unknown' && event.kind === 'settled');
}
/** History consistency only: unsigned assertions are not authenticated dispatch/remote facts. */
function legalHistory(attempt: BudgetAttempt, eventIds: Set<string>): boolean {
  if (!Array.isArray(attempt.events) || attempt.events.length > 3 ||
    !Number.isSafeInteger(attempt.fence) || attempt.fence < 0) return false;
  let status: BudgetAttempt['status'] = 'reserved';
  for (const event of attempt.events) {
    if (!event || !identifier(event.id) || eventIds.has(event.id) || event.attemptId !== attempt.id ||
      event.fence !== attempt.fence || !allowedTransition(status, event)) return false;
    eventIds.add(event.id);
    status = event.kind;
  }
  return status === attempt.status;
}
function balanced(state: CompletionBudget): boolean {
  if (!state || !Array.isArray(state.bots) || !Array.isArray(state.attempts) ||
    state.bots.some((bot) => !bot || typeof bot.runId !== 'string') ||
    state.attempts.some((attempt) => !attempt)) return false;
  const eventIds = new Set<string>();
  return state.version === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    state.revision < Number.MAX_SAFE_INTEGER && Number.isSafeInteger(state.deadlineMs) && state.deadlineMs > 0 &&
    typeof state.identityHash === 'string' && typeof state.profileHash === 'string' &&
    SHA256.test(state.identityHash) && SHA256.test(state.profileHash) &&
    (state.approvalReference === null || (typeof state.approvalReference === 'string' && SHA256.test(state.approvalReference))) &&
    state.bots.length === 4 && new Set(state.bots.map((bot) => bot.runId)).size === 4 &&
    new Set(state.attempts.map((attempt) => attempt.id)).size === state.attempts.length &&
    state.attempts.every((attempt) => identifier(attempt.id) && chargeValid(attempt.charge) && attempt.charge.attempts === 1 &&
      ['reserved', 'dispatched', 'unknown', 'settled', 'not_dispatched'].includes(attempt.status) &&
      state.bots.some((bot) => bot.runId === attempt.runId && resourceValid(bot.resource) &&
        attempt.charge.input === bot.resource.maxInput && attempt.charge.output === bot.resource.maxOutput &&
        attempt.charge.costMicros === bot.resource.maxCostMicros) &&
      legalHistory(attempt, eventIds)) &&
    state.revision === state.attempts.length + eventIds.size &&
    state.bots.every((bot) => chargeValid(bot.limits) && chargeValid(bot.used) && keys.every((key) => {
      const expected = state.attempts.filter((attempt) => attempt.runId === bot.runId)
        .reduce((sum, attempt) => sum + (attempt.status === 'not_dispatched' && key !== 'attempts' ? 0 : attempt.charge[key]), 0);
      return Number.isSafeInteger(expected) && expected === bot.used[key] && expected <= bot.limits[key];
    }));
}
/** Optional approval/resources are assertions from a FUTURE trusted boundary, not authentication. */
export function createCompletionBudget(manifest: CompletionManifest, deadlineMs: number, approved?: {
  reference: string;
  bots: Array<{ runId: string; limits: CompletionCharge; resource?: ResourceAssertion }>;
}): BudgetResult {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || (approved && (!SHA256.test(approved.reference) ||
    approved.bots.length !== 4 || new Set(approved.bots.map((bot) => bot.runId)).size !== 4 ||
    approved.bots.some((entry) => !manifest.identity.bots.some((bot) => bot.originalRunId === entry.runId))))) {
    return { ok: false, reason: 'invalid_budget' };
  }
  const state: CompletionBudget = { version: 1, identityHash: manifest.identityHash,
    profileHash: manifest.profileHash, deadlineMs, revision: 0, approvalReference: approved?.reference ?? null,
    bots: manifest.identity.bots.map((bot) => ({ runId: bot.originalRunId,
      limits: structuredClone(approved?.bots.find((entry) => entry.runId === bot.originalRunId)?.limits ?? zero()),
      used: zero(), resource: structuredClone(approved?.bots.find((entry) => entry.runId === bot.originalRunId)?.resource ?? null) })),
    attempts: [] };
  return balanced(state) ? { ok: true, value: state } : { ok: false, reason: 'invalid_budget' };
}
export interface AttemptReservation {
  current: CompletionIdentity;
  expectedRevision: number;
  nowMs: number;
  id: string;
  runId: string;
  chunkId: number | null;
  fence: number;
  input: number;
  output: number;
  costMicros: number;
}
/** A successful bookkeeping reservation is NEVER permission to repeat a dispatched call. */
export function reserveCompletionAttempt(
  state: CompletionBudget, manifest: CompletionManifest, request: AttemptReservation,
): ReservationResult {
  if (!balanced(state)) return { ok: false, reason: 'invalid_budget' };
  if (!currentContext(manifest, request.current) || state.profileHash !== manifest.profileHash ||
    state.identityHash !== manifest.identityHash) return { ok: false, reason: 'stale_context' };
  if (!state.approvalReference) return { ok: false, reason: 'execution_not_approved' };
  if (!Number.isSafeInteger(request.nowMs) || request.nowMs < 0 || request.nowMs >= state.deadlineMs) return { ok: false, reason: 'deadline' };
  const charge = { attempts: 1, input: request.input, output: request.output, costMicros: request.costMicros };
  if (!identifier(request.id) || !Number.isSafeInteger(request.fence) || request.fence < 0 || !chargeValid(charge) ||
    (request.chunkId !== null && !manifest.chunks.some((chunk) => chunk.id === request.chunkId))) {
    return { ok: false, reason: 'invalid_budget' };
  }
  const prior = state.attempts.find((attempt) => attempt.id === request.id);
  if (prior) {
    if (prior.runId !== request.runId || prior.chunkId !== request.chunkId || prior.fence !== request.fence ||
      !keys.every((key) => prior.charge[key] === charge[key])) return { ok: false, reason: 'conflicting_attempt' };
    return prior.status === 'reserved' ? { ok: true, value: state, reservation: 'replayed' }
      : { ok: false, reason: 'invalid_transition' };
  }
  if (request.expectedRevision !== state.revision) return { ok: false, reason: 'stale_revision' };
  const bot = state.bots.find((entry) => entry.runId === request.runId);
  const identity = manifest.identity.bots.find((entry) => entry.originalRunId === request.runId);
  if (!bot || !identity || !resourceValid(bot.resource) ||
    bot.resource.provider !== identity.provider || bot.resource.model !== identity.model ||
    request.input !== bot.resource.maxInput || request.output !== bot.resource.maxOutput ||
    request.costMicros !== bot.resource.maxCostMicros) {
    return { ok: false, reason: 'provider_resource_unproven' };
  }
  if (keys.some((key) => !Number.isSafeInteger(bot.used[key] + charge[key]) ||
    bot.used[key] + charge[key] > bot.limits[key])) return { ok: false, reason: 'budget_exhausted' };
  const next = structuredClone(state);
  const selected = next.bots.find((entry) => entry.runId === request.runId)!;
  for (const key of keys) selected.used[key] += charge[key];
  next.attempts.push({ id: request.id, runId: request.runId, chunkId: request.chunkId,
    fence: request.fence, charge, status: 'reserved', events: [] });
  next.revision++;
  return { ok: true, value: next, reservation: 'created' };
}
export function recordCompletionAttempt(state: CompletionBudget, event: {
  id: string; attemptId: string; fence: number; expectedRevision: number;
  kind: 'dispatched' | 'unknown' | 'settled' | 'not_dispatched'; provenNeverDispatched?: boolean;
}): BudgetResult {
  if (!balanced(state) || !event || !identifier(event.id)) return { ok: false, reason: 'invalid_budget' };
  const original = state.attempts.find((attempt) => attempt.id === event.attemptId);
  if (!original || event.fence !== original.fence) return { ok: false, reason: 'conflicting_attempt' };
  const semantic: BudgetEvent = { id: event.id, attemptId: event.attemptId, fence: event.fence,
    kind: event.kind, provenNeverDispatched: event.provenNeverDispatched ?? null };
  const previous = state.attempts.flatMap((attempt) => attempt.events).find((entry) => entry.id === event.id);
  if (previous) return previous.attemptId === semantic.attemptId && previous.fence === semantic.fence &&
    previous.kind === semantic.kind && previous.provenNeverDispatched === semantic.provenNeverDispatched
    ? { ok: true, value: state } : { ok: false, reason: 'conflicting_attempt' };
  if (event.expectedRevision !== state.revision) return { ok: false, reason: 'stale_revision' };
  if (!allowedTransition(original.status, semantic)) return { ok: false, reason: 'invalid_transition' };
  const next = structuredClone(state);
  const attempt = next.attempts.find((entry) => entry.id === event.attemptId)!;
  attempt.status = event.kind;
  attempt.events.push(semantic);
  if (event.kind === 'not_dispatched') {
    const bot = next.bots.find((entry) => entry.runId === attempt.runId)!;
    for (const key of ['input', 'output', 'costMicros'] as const) bot.used[key] -= attempt.charge[key];
  }
  next.revision++;
  return { ok: true, value: next };
}
