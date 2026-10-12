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

function sanitizeArg(val: unknown, secrets: Secret[]): unknown {
  if (typeof val === 'string') {
    return redactSecrets(val, secrets).text;
  }
  if (val instanceof Error) {
    val.message = redactSecrets(val.message, secrets).text;
    if (val.stack) {
      val.stack = redactSecrets(val.stack, secrets).text;
    }
    return val;
  }
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (obj.err instanceof Error) {
      obj.err.message = redactSecrets(obj.err.message, secrets).text;
      if (obj.err.stack) {
        obj.err.stack = redactSecrets(obj.err.stack, secrets).text;
      }
    }
    if (typeof obj.message === 'string') {
      obj.message = redactSecrets(obj.message, secrets).text;
    }
    if (typeof obj.msg === 'string') {
      obj.msg = redactSecrets(obj.msg, secrets).text;
    }
    if (typeof obj.detail === 'string') {
      obj.detail = redactSecrets(obj.detail, secrets).text;
    }
  }
  return val;
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
        if (err instanceof Error) {
          return {
            type: err.name,
            message: redactSecrets(err.message, knownSecrets).text,
            stack: redactSecrets(err.stack ?? '', knownSecrets).text,
          };
        }
        return err;
      },
    },
    hooks: {
      logMethod(inputArgs, method) {
        const sanitized = inputArgs.map((arg) => sanitizeArg(arg, knownSecrets));
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
