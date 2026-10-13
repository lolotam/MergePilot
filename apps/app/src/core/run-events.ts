import { EventEmitter } from 'node:events';
import type { ReviewRunStatus } from './types.js';

/**
 * Live run updates (ADR-0021). The worker (and the web server, for retries) publishes one small
 * event each time a review run row is created or changes status; the web server forwards it to the
 * dashboard over Server-Sent Events. Only ids and the status travel: no repo content, no secrets.
 */
export type RunEventKind = 'created' | 'updated';

export interface RunEvent {
  workspaceId: string;
  runId: string;
  status: ReviewRunStatus;
  kind: RunEventKind;
}

export type RunEventListener = (event: RunEvent) => void;

/** Publishing never throws and never blocks the caller: a lost event only delays the next refetch. */
export interface RunEventPublisher {
  publish(event: RunEvent): void;
}

export interface RunEventBus extends RunEventPublisher {
  /** Listens to one workspace's events; resolves to the function that stops listening. */
  subscribe(workspaceId: string, listener: RunEventListener): Promise<() => void>;
  close(): Promise<void>;
}

const RUN_STATUSES: readonly ReviewRunStatus[] = ['queued', 'running', 'completed', 'skipped', 'failed'];
const RUN_EVENT_KINDS: readonly RunEventKind[] = ['created', 'updated'];

/** One Redis pub/sub channel per workspace. */
export function runEventsChannel(workspaceId: string): string {
  return `mergepilot:runs:${workspaceId}`;
}

/** Keeps exactly the four allowed fields, so nothing else can ride along on the wire. */
export function toRunEventPayload(event: RunEvent): RunEvent {
  return { workspaceId: event.workspaceId, runId: event.runId, status: event.status, kind: event.kind };
}

/** Parses a message from the channel; anything malformed is dropped (returns null). */
export function parseRunEvent(raw: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.workspaceId !== 'string' || v.workspaceId.length === 0) return null;
  if (typeof v.runId !== 'string' || v.runId.length === 0) return null;
  if (!RUN_STATUSES.includes(v.status as ReviewRunStatus)) return null;
  if (!RUN_EVENT_KINDS.includes(v.kind as RunEventKind)) return null;
  return toRunEventPayload(v as unknown as RunEvent);
}

/**
 * In-process bus with the same interface as the Redis one, for tests and `memory:` Redis URLs
 * (web server and worker then share nothing, exactly like two processes without Redis).
 */
export class MemoryRunEventBus implements RunEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each SSE stream adds one listener; the stream limits (not Node's warning) cap them.
    this.emitter.setMaxListeners(0);
  }

  publish(event: RunEvent): void {
    const payload = toRunEventPayload(event);
    this.emitter.emit(runEventsChannel(payload.workspaceId), payload);
  }

  async subscribe(workspaceId: string, listener: RunEventListener): Promise<() => void> {
    const channel = runEventsChannel(workspaceId);
    const handler = (event: RunEvent) => listener(event);
    this.emitter.on(channel, handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.emitter.off(channel, handler);
    };
  }

  /** Listeners on one workspace's channel (tests check that a closed stream released its own). */
  listenerCount(workspaceId: string): number {
    return this.emitter.listenerCount(runEventsChannel(workspaceId));
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}
