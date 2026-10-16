import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { MergePilotConfigSchema, type MergePilotConfig } from './schema.js';

/** `maxFindings` stands for `review.maxFindings`. */
export type DefaultedKey = 'provider' | 'model' | 'maxFindings';

/** `defaulted` lists the keys filled from `options.defaults` (absent when none was). */
export type ConfigResult =
  | { ok: true; config: MergePilotConfig; defaulted?: DefaultedKey[] }
  | { ok: false; errors: string[] };

export interface ParseConfigOptions {
  /**
   * The provider and model used when the file leaves them out. The SaaS App passes the dashboard's
   * choice (it picks the provider and model itself), so its repos need not name them; the GitHub
   * Action passes nothing and `provider` stays required. Each key is filled on its own.
   */
  defaults?:
    | {
        provider: string;
        model?: string | undefined;
        /**
         * `review.maxFindings` when the file leaves it out: the SaaS App passes the workspace's
         * dashboard choice, and a file that names its own value keeps it (ADR-0033).
         */
        maxFindings?: number | undefined;
      }
    | undefined;
}

/** `data` with `review.maxFindings` filled when the file's `review` mapping leaves it out. */
function withDefaultMaxFindings(data: object, maxFindings: number | undefined): object {
  if (maxFindings === undefined) return data;
  const review: unknown = (data as { review?: unknown }).review;
  if (review === undefined) return { ...data, review: { maxFindings } };
  // A review value that is not a mapping is left for the schema to reject.
  if (typeof review !== 'object' || review === null || Array.isArray(review) || 'maxFindings' in review) return data;
  return { ...data, review: { ...review, maxFindings } };
}

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
export function parseConfig(yamlText: string, options: ParseConfigOptions = {}): ConfigResult {
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

  const filled: Partial<Record<'provider' | 'model', string>> = {};
  if (options.defaults && !('provider' in data)) filled.provider = options.defaults.provider;
  if (options.defaults?.model !== undefined && !('model' in data)) filled.model = options.defaults.model;
  const withLimit = withDefaultMaxFindings(data, options.defaults?.maxFindings);
  const parsed = MergePilotConfigSchema.safeParse({ ...filled, ...withLimit });
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => formatIssue(issue, data)) };
  }
  const defaulted: DefaultedKey[] = [
    ...(Object.keys(filled) as DefaultedKey[]),
    ...(withLimit !== data ? ['maxFindings' as const] : []),
  ];
  return { ok: true, config: parsed.data, ...(defaulted.length > 0 ? { defaulted } : {}) };
}
