/**
 * Shared fake child-process helpers for ClaudeCodeRunner tests.
 * Not exported from the package; Vitest picks them up via the test file import.
 */
import { EventEmitter } from 'node:events';
import type { SpawnLike } from './runner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** If set, the child emits this error on the process (e.g. ENOENT). */
  spawnError?: NodeJS.ErrnoException;
  /** If true, never emits exit — used to test timeout. */
  hang?: boolean;
}

type FakeChild = EventEmitter & {
  stdin: EventEmitter & { write(c: string): boolean; end(): void };
  stdout: EventEmitter;
  stderr: EventEmitter;
};

// ---------------------------------------------------------------------------
// makeChild — builds a fake ChildProcess-like object
// ---------------------------------------------------------------------------

export function makeChild(opts: FakeChildOptions = {}): { child: FakeChild; stdinChunks: string[] } {
  const stdinChunks: string[] = [];

  const stdin = new EventEmitter() as EventEmitter & { write(c: string): boolean; end(): void };
  stdin.write = (chunk: string) => { stdinChunks.push(chunk); return true; };
  stdin.end = () => undefined;

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const child = new EventEmitter() as FakeChild;
  Object.assign(child, { stdin, stdout, stderr });

  setImmediate(() => {
    if (opts.spawnError) { child.emit('error', opts.spawnError); return; }
    if (opts.hang) return;
    if (opts.stdout) stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) stderr.emit('data', Buffer.from(opts.stderr));
    stdout.emit('end');
    stderr.emit('end');
    child.emit('close', opts.exitCode ?? 0, null);
  });

  return { child, stdinChunks };
}

// ---------------------------------------------------------------------------
// makeSpawn — wraps makeChild into a SpawnLike + captures for assertions
// ---------------------------------------------------------------------------

export interface SpawnCapture {
  spawn: SpawnLike;
  /** Written stdin chunks (stable reference — safe to destructure). */
  stdinChunks: string[];
  /** Each call's full argv: [cmd, ...args] */
  capturedArgs: string[][];
  /** Each call's environment object. */
  capturedEnvs: NodeJS.ProcessEnv[];
}

export function makeSpawn(opts: FakeChildOptions): SpawnCapture {
  const capturedArgs: string[][] = [];
  const capturedEnvs: NodeJS.ProcessEnv[] = [];
  const stdinChunks: string[] = [];

  const spawn: SpawnLike = (cmd, args, spawnOpts) => {
    capturedArgs.push([cmd, ...(args ?? [])]);
    capturedEnvs.push((spawnOpts?.env ?? {}) as NodeJS.ProcessEnv);
    const result = makeChild(opts);
    // Monkey-patch stdin.write so we capture into the shared stable array.
    const origWrite = result.child.stdin.write.bind(result.child.stdin);
    result.child.stdin.write = (chunk: string) => { stdinChunks.push(chunk); return origWrite(chunk); };
    return result.child as ReturnType<SpawnLike>;
  };

  return { spawn, stdinChunks, capturedArgs, capturedEnvs };
}
