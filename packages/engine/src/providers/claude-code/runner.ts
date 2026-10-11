import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Secret } from '../../credentials/secret.js';
import { LlmFailure } from '../../llm/failure.js';
import type { TokenUsage } from '../../llm/types.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from '../../review/model.js';
import { redactSecrets } from '../../security/index.js';
import { resolveClaudeLaunch, type ResolvedClaudeLaunch } from './resolve-binary.js';

// ---------------------------------------------------------------------------
// Public SpawnLike type — injected in tests
// ---------------------------------------------------------------------------

/** Subset of `child_process.spawn` that the runner depends on. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'stdin' | 'stdout' | 'stderr' | 'kill'> & EventEmitter;

// ---------------------------------------------------------------------------
// CLI output shape
// ---------------------------------------------------------------------------

interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface CliResult {
  type: string;
  subtype?: string;
  is_error: boolean;
  result: string;
  usage?: CliUsage;
}

// ---------------------------------------------------------------------------
// Error classification patterns
// ---------------------------------------------------------------------------

const AUTH_PATTERN =
  /auth(?:entication|oriz(?:ation|ed))?|login|token.*(?:invalid|expired|bad)|invalid.*token|unauthorized|forbidden/i;

const QUOTA_PATTERN =
  /(?:usage|rate|subscription|daily|monthly|plan)\s*(?:limit|quota|cap|exceeded|exhausted)|quota\s*(?:exceeded|exhausted|limit)|exceeded.*(?:limit|quota)|limit\s*exceeded/i;

// ---------------------------------------------------------------------------
// Allowlist for child process environment variables
// ---------------------------------------------------------------------------

const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
];

const FORBIDDEN_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
];

function buildEnv(token: Secret): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Explicitly exclude forbidden vars (they would never be in env because we
  // build from the allowlist, but guard against future refactors).
  for (const key of FORBIDDEN_VARS) {
    delete env[key];
  }

  env['CLAUDE_CODE_OAUTH_TOKEN'] = token.reveal();
  return env;
}

// ---------------------------------------------------------------------------
// ClaudeCodeRunner
// ---------------------------------------------------------------------------

export interface ClaudeCodeRunnerOptions {
  /** User's Claude Code OAuth token, passed only into the child's env. */
  token: Secret;
  /** Working directory for the spawned CLI. */
  cwd: string;
  /**
   * Injected spawn function — defaults to Node's `child_process.spawn`.
   * Tests supply a fake that never touches the network.
   */
  spawn?: SpawnLike | undefined;
  /** Path or name of the Claude CLI binary. Defaults to `'claude'`. */
  binary?: string | undefined;
  /** Maximum wall-clock milliseconds before the child is killed. Defaults to 600 000. */
  timeoutMs?: number | undefined;
  /** Model identifier forwarded to the CLI via `--model`. Omitted when absent. */
  model?: string | undefined;
  /** Operating system platform. Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** File existence check function (injected for tests). */
  fileExists?: ((path: string) => boolean) | undefined;
  /** File reading function (injected for tests). */
  readFile?: ((path: string) => string) | undefined;
}

/**
 * Runs the **unmodified** official Claude Code CLI as a read-only subprocess.
 * The user's OAuth token is forwarded only into the child process environment;
 * MergePilot never reads, stores, refreshes, or forwards it anywhere else
 * (ADR-0006).
 */
export class ClaudeCodeRunner implements ReviewModel {
  readonly label = 'claude-code';

  readonly #token: Secret;
  readonly #cwd: string;
  readonly #spawn: SpawnLike;
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #model: string | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #fileExists: ((path: string) => boolean) | undefined;
  readonly #readFile: ((path: string) => string) | undefined;
  #resolvedLaunch: ResolvedClaudeLaunch | undefined;

  constructor(options: ClaudeCodeRunnerOptions) {
    this.#token = options.token;
    this.#cwd = options.cwd;
    this.#spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.#binary = options.binary ?? 'claude';
    this.#timeoutMs = options.timeoutMs ?? 600_000;
    this.#model = options.model;
    this.#platform = options.platform ?? process.platform;
    this.#fileExists = options.fileExists;
    this.#readFile = options.readFile;
  }

  async generate(request: ReviewModelRequest): Promise<ReviewModelResponse> {
    if (!this.#resolvedLaunch) {
      this.#resolvedLaunch = resolveClaudeLaunch({
        binary: this.#binary,
        platform: this.#platform,
        fileExists: this.#fileExists,
        readFile: this.#readFile,
      });
    }

    const { command, prefixArgs } = this.#resolvedLaunch;
    const args = [...prefixArgs, ...this.#buildArgs(request)];
    const env = buildEnv(this.#token);
    const stdinText = this.#buildStdin(request);

    const child = this.#spawn(command, args, {
      cwd: this.#cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new Promise<ReviewModelResponse>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let detachAbort = (): void => undefined;

      const fail = (failure: LlmFailure): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachAbort();
        reject(failure);
      };

      const succeed = (response: ReviewModelResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachAbort();
        resolve(response);
      };

      // Timeout
      const timer = setTimeout(() => {
        child.kill();
        fail(new LlmFailure({ code: 'TIMEOUT', provider: 'claude-code', message: 'Claude Code CLI timed out' }));
      }, this.#timeoutMs);

      // Abort signal
      if (request.signal) {
        const onAbort = (): void => {
          child.kill();
          fail(new LlmFailure({ code: 'ABORTED', provider: 'claude-code', message: 'request aborted' }));
        };
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        const signal = request.signal;
        signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      // Collect stdout / stderr
      (child.stdout as EventEmitter | null)?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      (child.stderr as EventEmitter | null)?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      // A child that exits before reading stdin raises EPIPE here; the close handler reports it.
      (child.stdin as Partial<EventEmitter> | null)?.on?.('error', () => undefined);

      // Write prompt to stdin
      (child.stdin as { write(s: string): boolean; end(): void } | null)?.write(stdinText);
      (child.stdin as { write(s: string): boolean; end(): void } | null)?.end();

      // Spawn error (e.g. ENOENT — binary not found)
      (child as EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          fail(
            new LlmFailure({
              code: 'BAD_REQUEST',
              provider: 'claude-code',
              message: 'Claude Code CLI not found on PATH',
            }),
          );
        } else {
          fail(
            new LlmFailure({
              code: 'UNKNOWN',
              provider: 'claude-code',
              message: redactSecrets(`Spawn error: ${err.message}`, [this.#token]).text,
            }),
          );
        }
      });

      // Process exit
      (child as EventEmitter).on('close', (code: number | null) => {
        if (settled) return;

        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

        // Try to parse JSON result
        let parsed: CliResult | undefined;
        try {
          const raw: unknown = JSON.parse(stdout);
          if (
            typeof raw === 'object' &&
            raw !== null &&
            'type' in raw &&
            'is_error' in raw &&
            'result' in raw
          ) {
            parsed = raw as CliResult;
          }
        } catch {
          // will fall through to UNKNOWN
        }

        if (parsed) {
          if (parsed.is_error || (code !== null && code !== 0)) {
            const rawMessage = parsed.result || stderr || 'Unknown error from Claude Code CLI';
            const message = redactSecrets(rawMessage, [this.#token]).text;
            fail(new LlmFailure({ code: classifyError(rawMessage), provider: 'claude-code', message }));
            return;
          }

          const text = redactSecrets(parsed.result, [this.#token]).text;
          const usage = mapUsage(parsed.usage);
          succeed({ text, finishReason: 'stop', ...(usage ? { usage } : {}) });
          return;
        }

        // Non-zero exit without parseable JSON
        if (code !== null && code !== 0) {
          const rawMessage = stderr || stdout || `Claude Code CLI exited with code ${String(code)}`;
          const message = redactSecrets(rawMessage, [this.#token]).text;
          fail(new LlmFailure({ code: classifyError(rawMessage), provider: 'claude-code', message }));
          return;
        }

        // Non-JSON stdout with exit 0 — unexpected
        const rawMessage = stderr || stdout || 'Claude Code CLI produced unexpected output';
        const message = redactSecrets(rawMessage, [this.#token]).text;
        fail(new LlmFailure({ code: 'UNKNOWN', provider: 'claude-code', message }));
      });
    });
  }

  #buildArgs(request: ReviewModelRequest): string[] {
    const args: string[] = [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read,Grep,Glob',
      '--disallowedTools',
      'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch',
      '--append-system-prompt',
      request.system,
    ];

    if (this.#model !== undefined) {
      args.push('--model', this.#model);
    }

    return args;
  }

  #buildStdin(request: ReviewModelRequest): string {
    let text = request.user;

    if (request.responseSchema !== undefined) {
      text +=
        '\n\nAnswer with exactly one JSON object matching this schema:\n' +
        JSON.stringify(request.responseSchema, null, 2);
    }

    return text;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyError(message: string): 'INVALID_CREDENTIAL' | 'QUOTA' | 'UNKNOWN' {
  if (AUTH_PATTERN.test(message)) return 'INVALID_CREDENTIAL';
  if (QUOTA_PATTERN.test(message)) return 'QUOTA';
  return 'UNKNOWN';
}

function mapUsage(usage: CliUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
