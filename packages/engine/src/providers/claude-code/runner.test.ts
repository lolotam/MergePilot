import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { Secret } from '../../credentials/secret.js';
import { LlmFailure } from '../../llm/failure.js';
import { ClaudeCodeRunner, type SpawnLike } from './runner.js';
import { makeChild, makeSpawn } from './_test-helpers.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN_VALUE = 'oauth-test-token-0000';
const token = new Secret(TOKEN_VALUE);

const SUCCESS_PAYLOAD = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'This is the review result.',
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
  },
});

const REQUEST = {
  system: 'You are a code reviewer.',
  user: 'Review this diff:\n```diff\n+console.log("hi")\n```',
  maxOutputTokens: 1024,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeRunner', () => {
  describe('happy path — successful JSON result', () => {
    it('returns parsed text and usage from CLI output', async () => {
      const { spawn, stdinChunks } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/tmp/repo', spawn });

      const response = await runner.generate(REQUEST);

      expect(response.text).toBe('This is the review result.');
      expect(response.finishReason).toBe('stop');
      expect(response.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      });
      expect(stdinChunks.join('')).toContain('Review this diff');
    });

    it('label is "claude-code"', () => {
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn: makeSpawn({}).spawn });
      expect(runner.label).toBe('claude-code');
    });

    it('uses system prompt as --append-system-prompt arg', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      const args = capturedArgs[0] ?? [];
      expect(args).toContain('--append-system-prompt');
      const idx = args.indexOf('--append-system-prompt');
      expect(args[idx + 1]).toBe('You are a code reviewer.');
    });

    it('passes --model when model option is set', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn, model: 'claude-opus-4-5' });
      await runner.generate(REQUEST);

      const args = capturedArgs[0] ?? [];
      expect(args).toContain('--model');
      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe('claude-opus-4-5');
    });

    it('omits --model when model option is not set', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      expect(capturedArgs[0] ?? []).not.toContain('--model');
    });

    it('uses custom binary name when specified', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn, binary: '/usr/local/bin/claude' });
      await runner.generate(REQUEST);

      expect((capturedArgs[0] ?? [])[0]).toBe('/usr/local/bin/claude');
    });

    it('omits usage field when CLI omits it', async () => {
      const noUsage = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
      const { spawn } = makeSpawn({ stdout: noUsage });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      const response = await runner.generate(REQUEST);

      expect(response.usage).toBeUndefined();
    });
  });

  describe('CLI args — read-only tool flags', () => {
    it('includes all required read-only flags', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      const args = capturedArgs[0] ?? [];
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args).toContain('--permission-mode');
      expect(args).toContain('default');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('--disallowedTools');
    });

    it('allowed tools include Read, Grep, Glob', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      const args = capturedArgs[0] ?? [];
      const idx = args.indexOf('--allowedTools');
      const allowedTools = args[idx + 1] ?? '';
      expect(allowedTools).toContain('Read');
      expect(allowedTools).toContain('Grep');
      expect(allowedTools).toContain('Glob');
    });

    it('disallowed tools include Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      const args = capturedArgs[0] ?? [];
      const idx = args.indexOf('--disallowedTools');
      const disallowedTools = args[idx + 1] ?? '';
      expect(disallowedTools).toContain('Bash');
      expect(disallowedTools).toContain('Edit');
      expect(disallowedTools).toContain('Write');
      expect(disallowedTools).toContain('MultiEdit');
      expect(disallowedTools).toContain('NotebookEdit');
      expect(disallowedTools).toContain('WebFetch');
      expect(disallowedTools).toContain('WebSearch');
    });

    it('prompt text is NOT in CLI args', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      const argsStr = JSON.stringify(capturedArgs[0] ?? []);
      expect(argsStr).not.toContain('Review this diff');
    });

    it('token is NOT in CLI args', async () => {
      const { spawn, capturedArgs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      const argsStr = JSON.stringify(capturedArgs[0] ?? []);
      expect(argsStr).not.toContain(TOKEN_VALUE);
    });
  });

  describe('environment variables', () => {
    it('env contains CLAUDE_CODE_OAUTH_TOKEN with the token value', async () => {
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      expect((capturedEnvs[0] ?? {})['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TOKEN_VALUE);
    });

    it('env does NOT contain ANTHROPIC_API_KEY', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-000';
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);
      delete process.env['ANTHROPIC_API_KEY'];

      expect(capturedEnvs[0] ?? {}).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    it('env does NOT contain OPENAI_API_KEY', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-test-000';
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);
      delete process.env['OPENAI_API_KEY'];

      expect(capturedEnvs[0] ?? {}).not.toHaveProperty('OPENAI_API_KEY');
    });

    it('env does NOT contain GEMINI_API_KEY', async () => {
      process.env['GEMINI_API_KEY'] = 'AIza-test-000';
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);
      delete process.env['GEMINI_API_KEY'];

      expect(capturedEnvs[0] ?? {}).not.toHaveProperty('GEMINI_API_KEY');
    });

    it('env does NOT contain GITHUB_TOKEN', async () => {
      process.env['GITHUB_TOKEN'] = 'ghs_test000';
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);
      delete process.env['GITHUB_TOKEN'];

      expect(capturedEnvs[0] ?? {}).not.toHaveProperty('GITHUB_TOKEN');
    });

    it('sets CLAUDE_CONFIG_DIR when configDir option is provided', async () => {
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({
        platform: 'linux',
        token,
        cwd: '/repo',
        spawn,
        configDir: '/tmp/claude-config-dir',
      });
      await runner.generate(REQUEST);

      expect((capturedEnvs[0] ?? {})['CLAUDE_CONFIG_DIR']).toBe('/tmp/claude-config-dir');
    });

    it('does NOT set CLAUDE_CONFIG_DIR when configDir option is not provided', async () => {
      const { spawn, capturedEnvs } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      expect(capturedEnvs[0] ?? {}).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    });
  });

  describe('stdin receives the prompt', () => {
    it('writes user prompt to stdin', async () => {
      const { spawn, stdinChunks } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      expect(stdinChunks.join('')).toContain(REQUEST.user);
    });

    it('includes JSON schema instruction in stdin when responseSchema is set', async () => {
      const { spawn, stdinChunks } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      const schema = { type: 'object', properties: { findings: { type: 'array' } } };
      await runner.generate({ ...REQUEST, responseSchema: schema });

      const stdinText = stdinChunks.join('');
      // Format (compact vs pretty) is an impl detail; check the key field names.
      expect(stdinText).toContain('"type"');
      expect(stdinText).toContain('"object"');
      expect(stdinText).toContain('"findings"');
    });
  });

  describe('error handling — is_error auth failure', () => {
    it('maps auth/login wording to INVALID_CREDENTIAL', async () => {
      const payload = JSON.stringify({
        type: 'result', subtype: 'error', is_error: true,
        result: 'Authentication failed: invalid login token',
      });
      const { spawn } = makeSpawn({ stdout: payload });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'INVALID_CREDENTIAL',
      );
    });

    it('maps "unauthorized" wording to INVALID_CREDENTIAL', async () => {
      const payload = JSON.stringify({
        type: 'result', subtype: 'error', is_error: true,
        result: 'Request is unauthorized',
      });
      const { spawn } = makeSpawn({ stdout: payload });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'INVALID_CREDENTIAL',
      );
    });
  });

  describe('error handling — usage/quota limit', () => {
    it('maps rate-limit/usage wording to QUOTA', async () => {
      const payload = JSON.stringify({
        type: 'result', subtype: 'error', is_error: true,
        result: 'You have exceeded your usage limit for today',
      });
      const { spawn } = makeSpawn({ stdout: payload });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'QUOTA',
      );
    });

    it('maps "quota" wording to QUOTA', async () => {
      const payload = JSON.stringify({
        type: 'result', subtype: 'error', is_error: true,
        result: 'Your subscription quota has been exhausted',
      });
      const { spawn } = makeSpawn({ stdout: payload });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'QUOTA',
      );
    });
  });

  describe('error handling — non-zero exit code', () => {
    it('throws LlmFailure on non-zero exit with unknown wording', async () => {
      const { spawn } = makeSpawn({ exitCode: 1, stderr: 'Something went wrong internally' });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'UNKNOWN',
      );
    });
  });

  describe('error handling — non-JSON stdout', () => {
    it('maps non-JSON stdout to UNKNOWN', async () => {
      const { spawn } = makeSpawn({ stdout: 'this is not JSON at all' });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'UNKNOWN',
      );
    });
  });

  describe('error handling — ENOENT (CLI not found)', () => {
    it('maps ENOENT spawn error to BAD_REQUEST with "not found" message', async () => {
      const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      const { spawn } = makeSpawn({ spawnError: err as NodeJS.ErrnoException });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof LlmFailure &&
          e.code === 'BAD_REQUEST' &&
          e.message.toLowerCase().includes('not found'),
      );
    });
  });

  describe('error handling — timeout', () => {
    it('kills child and throws TIMEOUT after timeoutMs', async () => {
      let killCalled = false;
      const fakeStdin = { write: (_c: string) => true, end: () => undefined };

      const spawn: SpawnLike = (_cmd, _args, _opts) => {
        const child = new EventEmitter() as ReturnType<SpawnLike>;
        Object.assign(child, {
          stdin: fakeStdin,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: () => { killCalled = true; },
        });
        return child;
      };

      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn, timeoutMs: 50 });

      await expect(runner.generate(REQUEST)).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'TIMEOUT',
      );
      expect(killCalled).toBe(true);
    });
  });

  describe('error handling — abort signal', () => {
    it('kills child and throws ABORTED when signal fires', async () => {
      let killCalled = false;
      const fakeStdin = { write: (_c: string) => true, end: () => undefined };

      const spawn: SpawnLike = (_cmd, _args, _opts) => {
        const child = new EventEmitter() as ReturnType<SpawnLike>;
        Object.assign(child, {
          stdin: fakeStdin,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: () => { killCalled = true; },
        });
        return child;
      };

      const ac = new AbortController();
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn, timeoutMs: 60_000 });

      setImmediate(() => ac.abort());

      await expect(runner.generate({ ...REQUEST, signal: ac.signal })).rejects.toSatisfy(
        (e: unknown) => e instanceof LlmFailure && e.code === 'ABORTED',
      );
      expect(killCalled).toBe(true);
    });
  });

  describe('secret redaction', () => {
    it('token value never appears in a thrown error message', async () => {
      const stderrWithToken = `Error: bad auth token=${TOKEN_VALUE}`;
      const { spawn } = makeSpawn({ exitCode: 1, stderr: stderrWithToken });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      let caught: unknown;
      try { await runner.generate(REQUEST); } catch (e) { caught = e; }

      expect(caught).toBeInstanceOf(LlmFailure);
      expect((caught as LlmFailure).message).not.toContain(TOKEN_VALUE);
    });

    it('token value never appears in response text if CLI were to echo it', async () => {
      const payload = JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        result: `Review ok. Your token is ${TOKEN_VALUE}`,
      });
      const { spawn } = makeSpawn({ stdout: payload });
      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });

      const response = await runner.generate(REQUEST);
      expect(response.text).not.toContain(TOKEN_VALUE);
    });
  });

  describe('spawn options', () => {
    it('uses shell: false', async () => {
      let capturedShell: unknown;
      const spawn: SpawnLike = (cmd, args, opts) => {
        capturedShell = (opts as Record<string, unknown>)['shell'];
        const { child } = makeChild({ stdout: SUCCESS_PAYLOAD });
        return child as ReturnType<SpawnLike>;
      };

      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/repo', spawn });
      await runner.generate(REQUEST);

      expect(capturedShell).toBe(false);
    });

    it('passes cwd to spawn options', async () => {
      let capturedCwd: unknown;
      const spawn: SpawnLike = (cmd, args, opts) => {
        capturedCwd = (opts as Record<string, unknown>)['cwd'];
        const { child } = makeChild({ stdout: SUCCESS_PAYLOAD });
        return child as ReturnType<SpawnLike>;
      };

      const runner = new ClaudeCodeRunner({ platform: 'linux', token, cwd: '/my/project', spawn });
      await runner.generate(REQUEST);

      expect(capturedCwd).toBe('/my/project');
    });
  });
});

describe('ClaudeCodeRunner token format', () => {
  it('rejects an Anthropic API key with a message that names the fix, without spawning', async () => {
    const spawn = vi.fn();
    const runner = new ClaudeCodeRunner({
      token: new Secret('sk-ant-api03-test-000'),
      cwd: '/repo',
      spawn: spawn as never,
      platform: 'linux',
    });
    await expect(runner.generate({ system: 's', user: 'u', maxOutputTokens: 10 })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
      message: expect.stringContaining('claude setup-token'),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
