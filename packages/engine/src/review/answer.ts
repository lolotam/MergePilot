import { z } from 'zod';
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

  // 2. Character-by-character scan for balanced objects
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  let hasStarted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        start = i;
        hasStarted = true;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const slice = text.slice(start, i + 1);
          if (!seen.has(slice)) {
            seen.add(slice);
            candidates.push(slice);
          }
          start = -1;
        }
      }
    }
  }

  const hasUnclosedObject = depth > 0 || (start !== -1 && hasStarted) || inString;

  return { candidates, hasUnclosedObject };
}

// ---------------------------------------------------------------------------
// Public parse function
// ---------------------------------------------------------------------------

export type ParseReviewAnswerResult =
  | { ok: true; summary: string; findings: Finding[]; droppedInvalid: number }
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

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      if (!firstParseError) {
        firstParseError = err instanceof Error ? err.message : String(err);
      }
      continue;
    }

    const loose = ReviewAnswerLooseSchema.safeParse(parsed);
    if (loose.success) {
      matchedAnswer = loose.data;
      break;
    } else if (!firstParseError) {
      firstParseError = loose.error.message;
    }
  }

  if (!matchedAnswer) {
    const isTruncated =
      options?.finishReason === 'max-tokens' ||
      options?.finishReason === 'length' ||
      hasUnclosedObject;

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
      error: `invalid-json: ${firstParseError ?? 'no valid JSON object found matching review schema'}`,
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
