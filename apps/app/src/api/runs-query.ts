import { z } from 'zod';
import type { ListReviewRunsOptions } from '../core/types.js';

export const ALLOWED_SORT_KEYS = [
  'createdAt',
  'repo',
  'pullNumber',
  'status',
  'provider',
  'model',
  'findingsCount',
  'costUsd',
  'duration',
] as const;

export type SortKey = (typeof ALLOWED_SORT_KEYS)[number];

const RUN_STATUSES = ['queued', 'running', 'completed', 'skipped', 'failed'] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_REPO_FILTERS = 50;
export const MAX_REPO_LENGTH = 200;
export const MAX_Q_LENGTH = 200;

/** A query param that may be sent once (`?repo=a`) or repeated (`?repo=a&repo=b`). */
function oneOrMany<T extends z.ZodType>(item: T, max: number) {
  return z
    .preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(item).max(max))
    .optional();
}

/** A whole non-negative number sent as a query string, e.g. `limit=20`. */
function intParam(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional();
}

/** `YYYY-MM-DD` (the date picker) or a full ISO 8601 date-time with an offset. */
const isoDateString = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const isoDateParam = isoDateString.optional();

/** GET /api/workspaces/:workspaceId/runs query string. Unknown params are ignored. */
export const RunsListQuerySchema = z.object({
  limit: intParam(1, 100),
  offset: intParam(0, 1_000_000_000),
  repo: oneOrMany(z.string().min(1).max(MAX_REPO_LENGTH), MAX_REPO_FILTERS),
  status: oneOrMany(z.enum(RUN_STATUSES), RUN_STATUSES.length),
  from: isoDateParam,
  to: isoDateParam,
  provider: z.string().trim().min(1).max(50).optional(),
  q: z.string().max(MAX_Q_LENGTH).optional(),
  sort: z.enum(ALLOWED_SORT_KEYS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

/** A date-only `from` starts at 00:00 UTC; a date-only `to` covers that whole UTC day. */
export function toDate(value: string, edge: 'start' | 'end'): Date {
  const date = new Date(value);
  return edge === 'end' && DATE_ONLY.test(value) ? new Date(date.getTime() + DAY_MS - 1) : date;
}

export type RunsQueryParseResult =
  | { ok: true; options: ListReviewRunsOptions }
  | { ok: false; code: 'invalid_sort' | 'invalid_query'; message: string };

/** Validates the runs list query; failures name the bad params but never echo their values. */
export function parseRunsListQuery(query: unknown): RunsQueryParseResult {
  const parsed = RunsListQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'query')))];
    if (fields.includes('sort')) {
      return {
        ok: false,
        code: 'invalid_sort',
        message: `Sort key must be one of: ${ALLOWED_SORT_KEYS.join(', ')}`,
      };
    }
    return { ok: false, code: 'invalid_query', message: `Invalid query parameter(s): ${fields.join(', ')}` };
  }

  const q = parsed.data;
  const from = q.from ? toDate(q.from, 'start') : undefined;
  const to = q.to ? toDate(q.to, 'end') : undefined;
  if (from && to && from.getTime() > to.getTime()) {
    return { ok: false, code: 'invalid_query', message: '`from` must not be after `to`' };
  }

  return {
    ok: true,
    options: {
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
      repo: q.repo,
      status: q.status,
      from,
      to,
      provider: q.provider,
      q: q.q,
      sort: q.sort,
      dir: q.dir ?? 'desc',
    },
  };
}

/**
 * POST /api/workspaces/:workspaceId/runs/retry-failed body: the runs page's repo and date filters
 * (status and search are ignored; only failed runs are retried) and an optional `dryRun`.
 */
export const RetryFailedBodySchema = z.object({
  repo: z.array(z.string().min(1).max(MAX_REPO_LENGTH)).max(MAX_REPO_FILTERS).optional(),
  from: isoDateParam,
  to: isoDateParam,
  dryRun: z.boolean().optional(),
});

export interface RetryFailedFilters {
  repo: string[] | undefined;
  from: Date | undefined;
  to: Date | undefined;
  dryRun: boolean;
}

export type RetryFailedParseResult =
  | { ok: true; filters: RetryFailedFilters }
  | { ok: false; message: string };

/** Validates the retry-failed body; failures name the bad fields but never echo their values. */
export function parseRetryFailedBody(body: unknown): RetryFailedParseResult {
  const parsed = RetryFailedBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'body')))];
    return { ok: false, message: `Invalid field(s): ${fields.join(', ')}` };
  }
  const b = parsed.data;
  const from = b.from ? toDate(b.from, 'start') : undefined;
  const to = b.to ? toDate(b.to, 'end') : undefined;
  if (from && to && from.getTime() > to.getTime()) {
    return { ok: false, message: '`from` must not be after `to`' };
  }
  return {
    ok: true,
    filters: { repo: b.repo && b.repo.length > 0 ? b.repo : undefined, from, to, dryRun: b.dryRun ?? false },
  };
}
