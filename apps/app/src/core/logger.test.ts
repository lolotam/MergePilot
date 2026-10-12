import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { createLogger } from './logger.js';

function createCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed) {
          try {
            lines.push(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // ignore non-json
          }
        }
      }
      callback();
    },
  });
  return { stream, lines };
}

describe('core/logger', () => {
  it('creates a logger with ISO timestamp and service base', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });

    logger.info('test message');

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line?.service).toBe('web');
    expect(line?.msg).toBe('test message');
    expect(typeof line?.time).toBe('string');
    // ISO 8601 timestamp check (e.g. 2026-10-12T14:30:00.000Z)
    expect(line?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('sets service to worker when requested', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'worker', stream });

    logger.info('worker started');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.service).toBe('worker');
  });

  it('respects LOG_LEVEL option', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', level: 'warn', stream });

    logger.info('should be ignored');
    logger.warn('warning visible');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('warning visible');
  });

  it('redacts sensitive object properties via pino redact', () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });

    const fakeToken = ['sec', 'ret', '123'].join('');
    const authVal = ['a', 'w'.repeat(10)].join('');
    const cookieVal = ['c', 'w'.repeat(10)].join('');
    logger.info({
      apiKey: fakeToken,
      token: fakeToken,
      secret: fakeToken,
      password: fakeToken,
      privateKey: fakeToken,
      nested: {
        apiKey: fakeToken,
      },
      req: {
        headers: {
          authorization: `Bearer ${authVal}`,
          cookie: `session=${cookieVal}`,
        },
      },
    }, 'event with secrets');

    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.apiKey).toBe('[REDACTED]');
    expect(line.token).toBe('[REDACTED]');
    expect(line.secret).toBe('[REDACTED]');
    expect(line.password).toBe('[REDACTED]');
    expect(line.privateKey).toBe('[REDACTED]');
    expect((line.nested as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    const headers = ((line.req as Record<string, unknown>).headers as Record<string, unknown>);
    expect(headers.authorization).toBe('[REDACTED]');
    expect(headers.cookie).toBe('[REDACTED]');
  });

  it('redacts free-text messages through redactSecrets helper', () => {
    const { stream, lines } = createCapture();
    // Build token at runtime so no token literal is in source
    const fakeAnthropic = ['sk', 'ant', 'api03', 'a'.repeat(25)].join('-');
    const logger = createLogger({ service: 'web', stream });

    logger.info(`Connecting using key ${fakeAnthropic} now`);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).not.toContain(fakeAnthropic);
    expect(lines[0]?.msg).toContain('[REDACTED:anthropic]');
  });

  it('redacts known secrets supplied to logger in free-text messages', () => {
    const { stream, lines } = createCapture();
    const runtimeSecretVal = ['my', 'custom', 'secret', 'val'].join('_');
    const knownSecret = new Secret(runtimeSecretVal);
    const logger = createLogger({ service: 'worker', stream, knownSecrets: [knownSecret] });

    logger.info(`Failed to load ${runtimeSecretVal} from store`);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).not.toContain(runtimeSecretVal);
    expect(lines[0]?.msg).toContain('[REDACTED:known]');
  });

  it('redacts error messages and stacks', () => {
    const { stream, lines } = createCapture();
    const fakeKey = ['sk', 'proj', 'b'.repeat(25)].join('-');
    const logger = createLogger({ service: 'web', stream });

    const err = new Error(`Connection to OpenAI with ${fakeKey} timed out`);
    logger.error({ err }, 'Request failed');

    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;
    expect(JSON.stringify(line)).not.toContain(fakeKey);
  });
});

describe('core/logger sanitizing never mutates caller values', () => {
  it('leaves the original Error untouched and logs a redacted copy', () => {
    const { stream, lines } = createCapture();
    const fakeKey = ['sk', 'proj', 'c'.repeat(25)].join('-');
    const logger = createLogger({ service: 'web', stream });
    const err = Object.assign(new Error(`call failed with ${fakeKey}`), { code: 'E_X' });
    const originalMessage = err.message;
    const originalStack = err.stack;

    logger.error({ err }, 'Request failed');
    logger.error(err);

    expect(err.message).toBe(originalMessage);
    expect(err.stack).toBe(originalStack);
    expect(err).toBeInstanceOf(Error);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toContain(fakeKey);
      const logged = line.err as Record<string, unknown>;
      expect(logged.type).toBe('Error');
      expect(logged.code).toBe('E_X');
      expect(logged.message).toContain('[REDACTED:');
    }
    expect(lines[1]?.msg).toContain('[REDACTED:');
  });

  it('redacts nested string fields of plain objects without mutating them', () => {
    const { stream, lines } = createCapture();
    const fakeKey = ['sk', 'ant', 'api03', 'd'.repeat(25)].join('-');
    const logger = createLogger({ service: 'web', stream });
    const payload = {
      detail: `bad key ${fakeKey}`,
      context: { inner: { note: `retry with ${fakeKey}` }, list: [`item ${fakeKey}`] },
    };
    const snapshot = JSON.parse(JSON.stringify(payload)) as unknown;

    logger.warn(payload, 'nested');

    expect(payload).toEqual(snapshot);
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain(fakeKey);
    const context = lines[0]?.context as { inner: { note: string }; list: string[] };
    expect(context.inner.note).toContain('[REDACTED:anthropic]');
    expect(context.list[0]).toContain('[REDACTED:anthropic]');
  });

  it('keeps our own ids readable while still redacting secret-looking free text', () => {
    const { stream, lines } = createCapture();
    const log = createLogger({ service: 'worker', stream });
    const workspace = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
    const runId = '880f7ffa-d04c-4334-822f-342f3399a4d9';
    const fake = ['s', 'k-', 'ant-', 'z'.repeat(40)].join('');
    log.info({ workspace, runId, detail: `failed with ${fake}` }, 'job');
    expect(lines[0]?.workspace).toBe(workspace);
    expect(lines[0]?.runId).toBe(runId);
    expect(String(lines[0]?.detail)).not.toContain(fake);
  });
});

