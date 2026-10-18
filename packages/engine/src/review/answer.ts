import { z } from 'zod';
import { parseJsonLenient } from './json-lenient.js';
import {
  FindingCategorySchema,
  FindingSchema,
  SeveritySchema,
  type Finding,
} from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * The JSON shape the model is asked to return.
 * Fields intentionally overlap with `Finding` but `id`, `side`, and `ruleRef` are
 * supplied / validated after parsing, so they are optional here.
 */
export const ReviewAnswerSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      side: z.enum(['LEFT', 'RIGHT']).optional(),
      title: z.string().min(1),
      body: z.string().min(1),
      severity: SeveritySchema,
      category: FindingCategorySchema,
      evidence: z.string().min(1),
      suggestion: z.string().optional(),
      ruleRef: z.string().optional(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/**
 * A loose top-level schema used only during parsing so that individual invalid
 * findings do not prevent the summary from being extracted.
 */
const ReviewAnswerLooseSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.unknown()),
});

/**
 * Some models answer with a summary and leave the findings list out entirely. That answer is
 * kept (no findings) only when no candidate has a list. Review callers may accept it as
 * empty after a normally finished reminder retry; audit callers keep it incomplete.
 */
const SummaryOnlyAnswerSchema = z.object({ summary: z.string().min(1) });

/** Incomplete-review reason for an answer that had a summary but no findings list. */
export const FINDINGS_MISSING_REASON = 'the model answered without a findings list (no inline findings from it)';


export type ParseErrorCode = 'truncated' | 'invalid-json' | 'empty-response';

export interface ParseAnswerOptions {
  finishReason?: string | undefined;
  outputTokens?: number | undefined;
}

export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

export interface ExtractedCandidates {
  candidates: string[];
  hasUnclosedObject: boolean;
}

const MAX_SCAN_RESTARTS = 20;

/**
 * Walks `text` from `from`, emitting every balanced top-level `{…}` span. String state is
 * tracked only INSIDE an object: quotes in surrounding prose (e.g. `it's "odd" {`) must not
 * flip it, and it is reset whenever an object closes so one object cannot leak into the next.
 * Returns the index of an object that opened and never closed, or -1.
 */
function scanBalancedObjects(text: string, from: number, emit: (slice: string) => void): number {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      }
      continue;
    }
    if (escape) {
      escape = false;
    } else if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        emit(text.slice(start, i + 1));
        start = -1;
        inString = false;
      }
    }
  }
  return depth > 0 ? start : -1;
}

/**
 * Extracts candidate JSON object substrings from `text`, checking code fences
 * first and then walking balanced `{…}` spans.
 */
export function extractCandidateObjects(text: string): ExtractedCandidates {
  const candidates: string[] = [];
  const seen = new Set<string>();

  // 1. Fenced code blocks
  const fenceRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const raw = fenceMatch[1];
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      candidates.push(raw);
    }
  }

  // 2. Balanced-object scan. A stray `{` in prose that never closes would swallow every
  //    object after it, so the scan resumes just past an unclosed opener (bounded).
  const push = (slice: string): void => {
    if (!seen.has(slice)) {
      seen.add(slice);
      candidates.push(slice);
    }
  };
  let from = 0;
  let hasUnclosedObject = false;
  for (let attempt = 0; attempt < MAX_SCAN_RESTARTS && from < text.length; attempt++) {
    const unclosedAt = scanBalancedObjects(text, from, push);
    if (unclosedAt < 0) break;
    hasUnclosedObject = true;
    from = unclosedAt + 1;
  }

  return { candidates, hasUnclosedObject };
}

/**
 * Whether an unparsable answer was cut off (worth a bigger-output retry) rather than wrong.
 * The finish reason decides first: `max-tokens` / `length` mean truncated; `stop`, `end_turn`
 * or any other explicit reason mean the model finished, so the answer is `invalid-json` even
 * when it contains an unclosed `{` (prose, a stray brace). Only a stream that ended WITHOUT a
 * finish reason (absent, or `error`, which `collectText` reports for a stream with no finish
 * chunk) falls back to the structural check (an object that opened and never closed).
 */
export function isTruncatedAnswer(finishReason: string | undefined, hasUnclosedObject: boolean): boolean {
  if (finishReason === 'max-tokens' || finishReason === 'length') return true;
  if (finishReason === undefined || finishReason === '' || finishReason === 'error') {
    return hasUnclosedObject;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public parse function
// ---------------------------------------------------------------------------

export type ParseReviewAnswerResult =
  | { ok: true; summary: string; findings: Finding[]; droppedInvalid: number; findingsMissing?: true; otherCandidatesRejected?: true; acceptedAsEmpty?: true }
  | { ok: false; error: string; code: ParseErrorCode };

/**
 * Parses the model's text output into structured findings.
 *
 * - Tolerates ```json fences, surrounding prose, and multiple objects.
 * - Picks the first balanced object matching the expected schema.
 * - Assigns stable ids `f1`, `f2`, …
 * - Drops individual findings that fail schema validation (counts them).
 * - Never throws.
 * - Returns clear error codes: `truncated`, `invalid-json`, `empty-response`.
 */
export function parseReviewAnswer(
  text: string,
  options?: ParseAnswerOptions,
): ParseReviewAnswerResult {
  if (!text || text.trim().length === 0) {
    return { ok: false, code: 'empty-response', error: 'empty-response: model returned no text' };
  }

  const { candidates, hasUnclosedObject } = extractCandidateObjects(text);

  let firstParseError: string | null = null;
  let matchedAnswer: z.infer<typeof ReviewAnswerLooseSchema> | null = null;
  let summaryOnly: string | null = null;
  let otherCandidatesRejected = false;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = parseJsonLenient(candidate);
    } catch (err) {
      otherCandidatesRejected = true;
      if (!firstParseError) {
        firstParseError = err instanceof Error ? err.message : String(err);
      }
      continue;
    }

    const loose = ReviewAnswerLooseSchema.safeParse(parsed);
    if (loose.success) {
      matchedAnswer = loose.data;
      break;
    }
    const bare = SummaryOnlyAnswerSchema.safeParse(parsed);
    // Only a truly absent key: `findings: null`, `0` or `""` is a present non-list, so invalid-json.
    if (bare.success && (parsed as Record<string, unknown>).findings === undefined) {
      summaryOnly ??= bare.data.summary;
    } else {
      otherCandidatesRejected = true;
      if (!firstParseError) firstParseError = loose.error.message;
    }
  }

  if (!matchedAnswer && summaryOnly !== null) {
    return {
      ok: true, summary: summaryOnly, findings: [], droppedInvalid: 0, findingsMissing: true,
      ...(otherCandidatesRejected ? { otherCandidatesRejected: true } : {}),
    };
  }

  if (!matchedAnswer) {
    const isTruncated = isTruncatedAnswer(options?.finishReason, hasUnclosedObject);

    if (isTruncated) {
      const finishDetail = options?.finishReason ? `finishReason: ${options.finishReason}` : 'unclosed JSON object';
      const tokensDetail = options?.outputTokens !== undefined ? `, outputTokens: ${options.outputTokens}` : '';
      return {
        ok: false,
        code: 'truncated',
        error: `truncated (${finishDetail}${tokensDetail})`,
      };
    }

    return {
      ok: false,
      code: 'invalid-json',
      error: `invalid-json: ${firstParseError ?? `the answer has no JSON object (${text.length} characters)`}`,
    };
  }

  const answer = matchedAnswer;
  const findings: Finding[] = [];
  let droppedInvalid = 0;
  let idCounter = 1;

  for (const rawFinding of answer.findings) {
    if (typeof rawFinding !== 'object' || rawFinding === null) {
      droppedInvalid++;
      continue;
    }
    const rf = rawFinding as Record<string, unknown>;
    const candidate: Record<string, unknown> = {
      ...rf,
      id: `f${idCounter}`,
      side: rf['side'] ?? 'RIGHT',
    };

    const result = FindingSchema.safeParse(candidate);
    if (result.success) {
      findings.push(result.data);
      idCounter++;
    } else {
      droppedInvalid++;
    }
  }

  return {
    ok: true,
    summary: answer.summary,
    findings,
    droppedInvalid,
  };
}
