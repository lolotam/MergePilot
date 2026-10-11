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


export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

/**
 * Finds the first balanced `{…}` object in `text`, tolerating surrounding prose
 * or a ```json … ``` code fence.
 */
function extractFirstObject(text: string): string | null {
  // Try fenced block first
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    return fenceMatch[1] ?? null;
  }

  // Walk character by character to find first balanced top-level object
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

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
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public parse function
// ---------------------------------------------------------------------------

export type ParseReviewAnswerResult =
  | { ok: true; summary: string; findings: Finding[]; droppedInvalid: number }
  | { ok: false; error: string };

/**
 * Parses the model's text output into structured findings.
 *
 * - Tolerates ```json fences and surrounding prose.
 * - Assigns stable ids `f1`, `f2`, …
 * - Drops individual findings that fail schema validation (counts them).
 * - Never throws.
 */
export function parseReviewAnswer(text: string): ParseReviewAnswerResult {
  const raw = extractFirstObject(text);
  if (raw === null) {
    return { ok: false, error: 'No JSON object found in model response.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const topResult = ReviewAnswerLooseSchema.safeParse(parsed);
  if (!topResult.success) {
    return {
      ok: false,
      error: `Schema validation failed: ${topResult.error.message}`,
    };
  }

  const answer = topResult.data;
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
