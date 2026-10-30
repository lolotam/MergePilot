import type { z } from 'zod';

/** Which settings field a validateSettings problem is about. */
export const SETTINGS_PROBLEM_FIELDS: Record<string, string> = {
  validation_error: 'settings.heavyModel',
  heavy_key_missing: 'settings.heavyProvider',
  fallback_duplicate: 'settings.fallback',
  fallback_key_missing: 'settings.fallback',
};

/** A refused restore: `field` names the part of the file that failed (e.g. `settings.provider`). */
export class RestoreProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string | undefined,
  ) {
    super(message);
    this.name = 'RestoreProblem';
  }
}

/** `credentials.0.provider` → `credentials[0].provider`. */
function fieldOf(prefix: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part)),
    prefix,
  );
}

/** A schema failure as a 400 `validation_error` naming the field; `secret` is redacted from the message. */
export function zodProblem(prefix: string, error: z.ZodError, secret?: string): RestoreProblem {
  const issue = error.issues[0];
  const field = fieldOf(prefix, issue?.path ?? []) || undefined;
  const message = `${field ?? 'file'}: ${issue?.message ?? 'Invalid value'}`;
  return new RestoreProblem(400, 'validation_error', secret ? message.replaceAll(secret, '[REDACTED]') : message, field);
}
