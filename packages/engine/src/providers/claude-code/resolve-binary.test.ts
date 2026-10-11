import { describe, it, expect } from 'vitest';
import { Secret } from '../../credentials/secret.js';
import { LlmFailure } from '../../llm/failure.js';
import { resolveClaudeLaunch } from './resolve-binary.js';
import { ClaudeCodeRunner } from './runner.js';
import { makeSpawn } from './_test-helpers.js';

// ---------------------------------------------------------------------------
// Realistic npm shim text fixture
// ---------------------------------------------------------------------------

const REALISTIC_NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

const SUCCESS_PAYLOAD = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Review ok',
});

const REQUEST = {
  system: 'You are a code reviewer.',
  user: 'Review this diff',
};

describe('resolveClaudeLaunch', () => {
  describe('linux passthrough', () => {
    it('returns binary and empty prefixArgs on Linux', () => {
      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'linux',
      });

      expect(result).toEqual({
        command: 'claude',
        prefixArgs: [],
      });
    });

    it('returns custom binary path as-is on Linux', () => {
      const result = resolveClaudeLaunch({
        binary: '/usr/local/bin/claude',
        platform: 'linux',
      });

      expect(result).toEqual({
        command: '/usr/local/bin/claude',
        prefixArgs: [],
      });
    });

    it('returns binary and empty prefixArgs on macOS (darwin)', () => {
      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'darwin',
      });

      expect(result).toEqual({
        command: 'claude',
        prefixArgs: [],
      });
    });
  });

  describe('windows absolute .exe', () => {
    it('uses absolute .exe directly on Windows without searching PATH', () => {
      const result = resolveClaudeLaunch({
        binary: 'C:\\Tools\\claude.exe',
        platform: 'win32',
      });

      expect(result).toEqual({
        command: 'C:\\Tools\\claude.exe',
        prefixArgs: [],
      });
    });

    it('handles uppercase .EXE extension on Windows', () => {
      const result = resolveClaudeLaunch({
        binary: 'D:\\bin\\CLAUDE.EXE',
        platform: 'win32',
      });

      expect(result).toEqual({
        command: 'D:\\bin\\CLAUDE.EXE',
        prefixArgs: [],
      });
    });
  });

  describe('windows .exe on PATH', () => {
    it('finds claude.exe on PATH and returns it with empty prefixArgs', () => {
      const env = { PATH: 'C:\\bin;C:\\tools' };
      const existing = new Set(['C:\\tools\\claude.exe']);

      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'win32',
        env,
        fileExists: (p) => existing.has(p),
      });

      expect(result).toEqual({
        command: 'C:\\tools\\claude.exe',
        prefixArgs: [],
      });
    });

    it('honours PATH order when multiple directories contain claude.exe', () => {
      const env = { PATH: 'C:\\first;C:\\second' };
      const existing = new Set(['C:\\first\\claude.exe', 'C:\\second\\claude.exe']);

      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'win32',
        env,
        fileExists: (p) => existing.has(p),
      });

      expect(result.command).toBe('C:\\first\\claude.exe');
    });

    it('honours PATHEXT-style order (.exe before .cmd in the same directory)', () => {
      const env = { PATH: 'C:\\bin' };
      const existing = new Set(['C:\\bin\\claude.exe', 'C:\\bin\\claude.cmd']);

      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'win32',
        env,
        fileExists: (p) => existing.has(p),
      });

      expect(result).toEqual({
        command: 'C:\\bin\\claude.exe',
        prefixArgs: [],
      });
    });
  });

  describe('windows .cmd -> node + cli.js (with realistic npm shim text)', () => {
    it('resolves npm shim to node + cli.js', () => {
      const cmdPath = 'C:\\npm\\claude.cmd';
      const cliJsPath = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
      const existing = new Set([cmdPath, cliJsPath]);

      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'win32',
        env: { PATH: 'C:\\npm' },
        fileExists: (p) => existing.has(p),
        readFile: (p) => {
          if (p === cmdPath) return REALISTIC_NPM_SHIM;
          throw new Error('Unexpected file read: ' + p);
        },
      });

      expect(result).toEqual({
        command: process.execPath,
        prefixArgs: [cliJsPath],
      });
    });

    it('handles shim with %~dp0 syntax', () => {
      const cmdPath = 'C:\\Users\\test\\npm\\claude.cmd';
      const cliJsPath = 'C:\\Users\\test\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
      const shimText = '@node "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n';

      const existing = new Set([cmdPath, cliJsPath]);

      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'win32',
        env: { PATH: 'C:\\Users\\test\\npm' },
        fileExists: (p) => existing.has(p),
        readFile: (p) => (p === cmdPath ? shimText : ''),
      });

      expect(result).toEqual({
        command: process.execPath,
        prefixArgs: [cliJsPath],
      });
    });

    it('handles shim with forward slashes', () => {
      const cmdPath = 'C:\\npm\\claude.cmd';
      const cliJsPath = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
      const shimText = 'node "%dp0%/node_modules/@anthropic-ai/claude-code/cli.js" %*\n';

      const existing = new Set([cmdPath, cliJsPath]);

      const result = resolveClaudeLaunch({
        binary: 'claude',
        platform: 'win32',
        env: { PATH: 'C:\\npm' },
        fileExists: (p) => existing.has(p),
        readFile: (p) => (p === cmdPath ? shimText : ''),
      });

      expect(result).toEqual({
        command: process.execPath,
        prefixArgs: [cliJsPath],
      });
    });
  });

  describe('.cmd whose cli.js is missing -> not found', () => {
    it('throws LlmFailure BAD_REQUEST when referenced cli.js does not exist', () => {
      const cmdPath = 'C:\\npm\\claude.cmd';
      // Only the .cmd exists; the referenced cli.js is missing
      const existing = new Set([cmdPath]);

      let error: unknown;
      try {
        resolveClaudeLaunch({
          binary: 'claude',
          platform: 'win32',
          env: { PATH: 'C:\\npm' },
          fileExists: (p) => existing.has(p),
          readFile: () => REALISTIC_NPM_SHIM,
        });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(LlmFailure);
      expect((error as LlmFailure).code).toBe('BAD_REQUEST');
      expect((error as LlmFailure).message).toBe('Claude Code CLI not found on PATH');
    });
  });

  describe('nothing on PATH -> not found', () => {
    it('throws LlmFailure BAD_REQUEST when neither .exe nor .cmd exists', () => {
      let error: unknown;
      try {
        resolveClaudeLaunch({
          binary: 'claude',
          platform: 'win32',
          env: { PATH: 'C:\\empty\\dir;C:\\another' },
          fileExists: () => false,
        });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(LlmFailure);
      expect((error as LlmFailure).code).toBe('BAD_REQUEST');
      expect((error as LlmFailure).message).toBe('Claude Code CLI not found on PATH');
    });

    it('throws LlmFailure BAD_REQUEST when PATH is empty or missing', () => {
      let error: unknown;
      try {
        resolveClaudeLaunch({
          binary: 'claude',
          platform: 'win32',
          env: {},
          fileExists: () => false,
        });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(LlmFailure);
      expect((error as LlmFailure).code).toBe('BAD_REQUEST');
      expect((error as LlmFailure).message).toBe('Claude Code CLI not found on PATH');
    });
  });

  describe('never returns .cmd or .bat as command', () => {
    it('throws rather than returning .cmd when given absolute .cmd path that cannot resolve js', () => {
      let error: unknown;
      try {
        resolveClaudeLaunch({
          binary: 'C:\\bin\\claude.cmd',
          platform: 'win32',
          fileExists: () => false,
        });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(LlmFailure);
      expect((error as LlmFailure).code).toBe('BAD_REQUEST');
    });
  });
});

describe('ClaudeCodeRunner Windows resolution integration', () => {
  const token = new Secret('sk-test-000');

  it('the runner spawns node with cli.js first and still never uses a shell', async () => {
    const cmdPath = 'C:\\npm\\claude.cmd';
    const cliJsPath = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const existing = new Set([cmdPath, cliJsPath]);

    let capturedCommand: string | undefined;
    let capturedArgs: readonly string[] | undefined;
    let capturedShell: boolean | undefined;

    const { spawn } = makeSpawn({ stdout: SUCCESS_PAYLOAD });
    const wrappedSpawn: typeof spawn = (cmd, args, opts) => {
      capturedCommand = cmd;
      capturedArgs = args;
      capturedShell = opts.shell as boolean | undefined;
      return spawn(cmd, args, opts);
    };

    const runner = new ClaudeCodeRunner({
      token,
      cwd: 'C:\\repo',
      spawn: wrappedSpawn,
      platform: 'win32',
      fileExists: (p) => existing.has(p),
      readFile: (p) => (p === cmdPath ? REALISTIC_NPM_SHIM : ''),
    });

    // PATH environment for test resolution
    const origPath = process.env['PATH'];
    process.env['PATH'] = 'C:\\npm';
    try {
      const response = await runner.generate(REQUEST);
      expect(response.text).toBe('Review ok');
    } finally {
      process.env['PATH'] = origPath;
    }

    expect(capturedCommand).toBe(process.execPath);
    expect(capturedShell).toBe(false);
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs?.[0]).toBe(cliJsPath);
    expect(capturedArgs).toContain('-p');
    expect(capturedArgs).toContain('--output-format');
  });

  it('lazily resolves launch on first generate and reuses cached resolution', async () => {
    const cmdPath = 'C:\\npm\\claude.cmd';
    const cliJsPath = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const existing = new Set([cmdPath, cliJsPath]);

    let readCount = 0;
    const { spawn } = makeSpawn({ stdout: SUCCESS_PAYLOAD });

    const runner = new ClaudeCodeRunner({
      token,
      cwd: 'C:\\repo',
      spawn,
      platform: 'win32',
      fileExists: (p) => existing.has(p),
      readFile: (p) => {
        if (p === cmdPath) {
          readCount++;
          return REALISTIC_NPM_SHIM;
        }
        return '';
      },
    });

    const origPath = process.env['PATH'];
    process.env['PATH'] = 'C:\\npm';
    try {
      await runner.generate(REQUEST);
      expect(readCount).toBe(1);

      await runner.generate(REQUEST);
      // Resolved once lazily; second call reuses cache
      expect(readCount).toBe(1);
    } finally {
      process.env['PATH'] = origPath;
    }
  });
});
