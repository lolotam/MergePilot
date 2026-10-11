import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LlmFailure } from '../../llm/failure.js';

export interface ResolveClaudeLaunchOptions {
  /** Name or path of binary to launch. Defaults to `'claude'`. */
  binary?: string | undefined;
  /** OS platform to resolve for. Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Environment variables to read PATH from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** File existence check function (injected for tests). */
  fileExists?: ((path: string) => boolean) | undefined;
  /** File reading function (injected for tests). */
  readFile?: ((path: string) => string) | undefined;
}

export interface ResolvedClaudeLaunch {
  command: string;
  prefixArgs: string[];
}

function getPathVar(env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path' && typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function resolveShimJs(
  cmdPath: string,
  readFile: (path: string) => string,
  fileExists: (path: string) => boolean,
): string | undefined {
  let content: string;
  try {
    content = readFile(cmdPath);
  } catch {
    return undefined;
  }

  const shimDir = path.win32.dirname(cmdPath);
  const candidates: string[] = [];

  // 1. Quoted strings ending with .js: "..." or '...'
  const quotedRegex = /["']([^"'\r\n]+?\.js)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(content)) !== null) {
    if (match[1]) candidates.push(match[1]);
  }

  // 2. Unquoted tokens with %dp0% or %~dp0 ending with .js
  const tokenRegex = /(?:^|\s)(%~?dp0%?[^\s"'\r\n]*?\.js)(?=\s|$)/gi;
  while ((match = tokenRegex.exec(content)) !== null) {
    if (match[1]) candidates.push(match[1]);
  }

  // 3. Unquoted tokens containing node_modules ending with .js
  const nmRegex = /(?:^|\s)([^\s"'\r\n]*node_modules[^\s"'\r\n]*?\.js)(?=\s|$)/gi;
  while ((match = nmRegex.exec(content)) !== null) {
    if (match[1]) candidates.push(match[1]);
  }

  for (const raw of candidates) {
    // Strip leading %~dp0\ or %dp0%\ (or without backslash)
    const cleaned = raw.replace(/^%~?dp0%?[\\/]?/i, '');
    let resolved: string;
    if (path.win32.isAbsolute(cleaned)) {
      resolved = path.win32.normalize(cleaned);
    } else {
      resolved = path.win32.resolve(shimDir, cleaned);
    }

    if (fileExists(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

/**
 * Resolves the command and arguments needed to spawn the Claude Code CLI.
 * On Windows, npm global shims (.cmd) cannot be spawned with shell: false,
 * so we resolve them to node.exe + the referenced cli.js entry point.
 */
export function resolveClaudeLaunch(options: ResolveClaudeLaunchOptions = {}): ResolvedClaudeLaunch {
  const binary = options.binary ?? 'claude';
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  // Non-Windows: passthrough
  if (platform !== 'win32') {
    return { command: binary, prefixArgs: [] };
  }

  // Windows: absolute path ending in .exe -> use directly
  if (path.win32.isAbsolute(binary) && binary.toLowerCase().endsWith('.exe')) {
    return { command: binary, prefixArgs: [] };
  }

  // Windows: absolute path ending in .cmd -> resolve shim
  if (path.win32.isAbsolute(binary) && binary.toLowerCase().endsWith('.cmd')) {
    if (fileExists(binary)) {
      const cliJs = resolveShimJs(binary, readFile, fileExists);
      if (cliJs) {
        return { command: process.execPath, prefixArgs: [cliJs] };
      }
    }
    throw new LlmFailure({
      code: 'BAD_REQUEST',
      provider: 'claude-code',
      message: 'Claude Code CLI not found on PATH',
    });
  }

  // Windows: search each directory on PATH (honour PATHEXT-style order: .exe before .cmd)
  const pathVar = getPathVar(env);
  const dirs = pathVar
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter((d) => d.length > 0);

  const baseName = binary.replace(/\.(exe|cmd|bat)$/i, '');

  for (const dir of dirs) {
    const exeCandidate = path.win32.join(dir, `${baseName}.exe`);
    if (fileExists(exeCandidate)) {
      return { command: exeCandidate, prefixArgs: [] };
    }

    const cmdCandidate = path.win32.join(dir, `${baseName}.cmd`);
    if (fileExists(cmdCandidate)) {
      const cliJs = resolveShimJs(cmdCandidate, readFile, fileExists);
      if (cliJs) {
        return { command: process.execPath, prefixArgs: [cliJs] };
      }
    }
  }

  throw new LlmFailure({
    code: 'BAD_REQUEST',
    provider: 'claude-code',
    message: 'Claude Code CLI not found on PATH',
  });
}
