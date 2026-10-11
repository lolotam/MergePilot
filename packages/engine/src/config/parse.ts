import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { MergePilotConfigSchema, type MergePilotConfig } from './schema.js';

export type ConfigResult = { ok: true; config: MergePilotConfig } | { ok: false; errors: string[] };

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let current = data;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function formatIssue(issue: z.core.$ZodIssue, data: unknown): string {
  const path = issue.path.join('.');
  if (issue.code !== 'custom' && path && valueAt(data, issue.path) === undefined) {
    return `${path}: required`;
  }
  return `${path || 'config'}: ${issue.message}`;
}

/**
 * Parses `.mergepilot.yml` text. Never throws: YAML syntax errors and schema violations
 * come back as readable messages prefixed with the key path, so a shell can print them
 * as-is. Callers pass the text; the engine never reads files itself.
 */
export function parseConfig(yamlText: string): ConfigResult {
  const doc = parseDocument(yamlText, { prettyErrors: false });
  const syntaxError = doc.errors[0];
  if (syntaxError) {
    const line = syntaxError.linePos?.[0].line ?? 1;
    return { ok: false, errors: [`YAML syntax error at line ${line}: ${syntaxError.code}`] };
  }

  const data: unknown = doc.toJS() ?? {};
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['config: must be a mapping of keys to values'] };
  }

  const parsed = MergePilotConfigSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => formatIssue(issue, data)) };
  }
  return { ok: true, config: parsed.data };
}
