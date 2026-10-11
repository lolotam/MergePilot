import { describe, expect, it } from 'vitest';
import { AuditSchema, MergePilotConfigSchema } from './schema.js';

describe('AuditSchema', () => {
  it('applies defaults correctly', () => {
    const parsed = AuditSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      output: 'summary',
      maxFiles: 200,
      include: ['**/*'],
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
    });
  });

  it('accepts valid custom values', () => {
    const parsed = AuditSchema.parse({
      enabled: true,
      schedule: '0 3 * * 1',
      output: 'issue',
      maxFiles: 100,
      include: ['src/**', 'lib/**'],
      exclude: ['**/test/**'],
    });
    expect(parsed).toEqual({
      enabled: true,
      schedule: '0 3 * * 1',
      output: 'issue',
      maxFiles: 100,
      include: ['src/**', 'lib/**'],
      exclude: ['**/test/**'],
    });
  });

  it('rejects invalid output', () => {
    expect(() => AuditSchema.parse({ output: 'email' })).toThrow();
  });

  it('rejects non-positive maxFiles', () => {
    expect(() => AuditSchema.parse({ maxFiles: 0 })).toThrow();
    expect(() => AuditSchema.parse({ maxFiles: -5 })).toThrow();
  });

  it('is integrated in MergePilotConfigSchema', () => {
    const config = MergePilotConfigSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    expect(config.audit).toEqual({
      enabled: false,
      output: 'summary',
      maxFiles: 200,
      include: ['**/*'],
      exclude: ['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**'],
    });
  });
});
