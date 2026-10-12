import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions as PinoOptions,
} from 'pino';
import { redactSecrets, type Secret } from '@mergepilot/engine';

export type ServiceName = 'web' | 'worker';

export interface LoggerOptions {
  service?: ServiceName;
  level?: string;
  stream?: DestinationStream;
  knownSecrets?: Secret[];
}

const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  '*.apiKey',
  '*.token',
  '*.secret',
  '*.password',
  '*.privateKey',
  'apiKey',
  'token',
  'secret',
  'password',
  'privateKey',
];

const MAX_SANITIZE_DEPTH = 4;

export interface SanitizedError {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
}

function redactText(text: string, secrets: Secret[]): string {
  return redactSecrets(text, secrets).text;
}

/** Plain, redacted copy of an Error. The original Error is never touched. */
export function sanitizeError(err: Error, secrets: Secret[]): SanitizedError {
  const out: SanitizedError = { type: err.name, message: redactText(err.message, secrets) };
  if (err.stack) out.stack = redactText(err.stack, secrets);
  const code: unknown = (err as { code?: unknown }).code;
  if (typeof code === 'string') out.code = redactText(code, secrets);
  else if (typeof code === 'number') out.code = code;
  return out;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a redacted copy of a log argument. Strings are redacted, Errors become
 * plain objects, plain objects and arrays are copied recursively (up to a small
 * depth). Anything else (request objects, Dates, class instances) is passed
 * through unchanged. The caller's values are never mutated.
 */
const ID_FIELDS = new Set([
  'reqId',
  'workspace',
  'workspaceId',
  'userId',
  'runId',
  'jobId',
  'deliveryId',
  'installationId',
  'targetId',
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An id field keeps its value only when the generic entropy rule is the sole reason it would be
 * hidden; known key formats and exact known secrets are still redacted in id fields too.
 */
function keepIdUnlessSecret(value: string, secrets: Secret[]): string {
  const redacted = redactText(value, secrets);
  return /^\[REDACTED:entropy[^\]]*\]$/.test(redacted) ? value : redacted;
}

function sanitizeValue(val: unknown, secrets: Secret[], depth: number): unknown {
  if (typeof val === 'string') return redactText(val, secrets);
  if (val instanceof Error) return sanitizeError(val, secrets);
  if (depth >= MAX_SANITIZE_DEPTH) return val;
  if (Array.isArray(val)) return val.map((item) => sanitizeValue(item, secrets, depth + 1));
  if (isPlainObject(val)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(val)) {
      // Our own identifiers (UUIDs, cuid-like ids, delivery ids) look random to the entropy
      // pattern; they are not secrets and are what an operator searches the logs by.
      copy[key] =
        ID_FIELDS.has(key) && typeof item === 'string' && SAFE_ID.test(item)
          ? keepIdUnlessSecret(item, secrets)
          : sanitizeValue(item, secrets, depth + 1);
    }
    return copy;
  }
  return val;
}

function sanitizeArgs(args: unknown[], secrets: Secret[]): unknown[] {
  return args.map((arg, index) => {
    if (index === 0 && arg instanceof Error) {
      // pino turns a leading Error into `{ err, msg }`; keep that shape with a copy.
      const err = sanitizeError(arg, secrets);
      return args.length === 1 ? { err, msg: err.message } : { err };
    }
    return sanitizeValue(arg, secrets, 0);
  });
}

export function createLogger(options?: LoggerOptions): Logger {
  const service = options?.service ?? 'web';
  const level = options?.level ?? process.env.LOG_LEVEL ?? 'info';
  const knownSecrets = options?.knownSecrets ?? [];

  const pinoConfig: PinoOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
    serializers: {
      err: (err: unknown) => {
        if (err instanceof Error) return sanitizeError(err, knownSecrets);
        return err;
      },
    },
    hooks: {
      logMethod(inputArgs, method) {
        const sanitized = sanitizeArgs(inputArgs, knownSecrets);
        return method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  };

  if (options?.stream) {
    return pino(pinoConfig, options.stream);
  }
  return pino(pinoConfig);
}

export const logger = createLogger({ service: 'web' });
export const workerLogger = createLogger({ service: 'worker' });
