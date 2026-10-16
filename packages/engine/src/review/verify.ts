/**
 * Verification pass (PRD v0.2 §7 step 8): re-checks model findings against the code in a focused
 * second model call before publishing. The prompt lives in `verify-prompt.ts`; this module parses
 * the verdicts and applies them (ADR-0028: a "plausible" finding is kept at confidence ≤ 0.69).
 */

import { z } from 'zod';
import { parseJsonLenient } from './json-lenient.js';
import { extractCandidateObjects, isTruncatedAnswer } from './answer.js';
import type { Finding } from './types.js';

export {
  buildVerifyPrompt,
  type BuiltVerifyPrompt,
  type VerifyPromptInput,
  type VerifyReviewableFile,
} from './verify-prompt.js';

// ---------------------------------------------------------------------------
// Schemas and Answer Parsing
// ---------------------------------------------------------------------------

/**
 * `plausible` (ADR-0028): consistent with the code shown, but the code that would prove it is not
 * shown and the finding says which code would; kept with its confidence capped.
 */
export const VerdictDecisionSchema = z.enum(['confirmed', 'plausible', 'rejected']);
export type VerdictDecision = z.infer<typeof VerdictDecisionSchema>;

export const FindingVerdictSchema = z.object({
  id: z.string().min(1),
  verdict: VerdictDecisionSchema,
  reason: z.string(),
});
export type FindingVerdict = z.infer<typeof FindingVerdictSchema>;

export const VerifyAnswerSchema = z.object({
  verdicts: z.array(FindingVerdictSchema),
});
export type VerifyAnswer = z.infer<typeof VerifyAnswerSchema>;

const VerifyAnswerLooseSchema = z.object({
  verdicts: z.array(z.unknown()),
});

export type ParseVerifyErrorCode = 'truncated' | 'invalid-json' | 'empty-response';

export interface ParseVerifyAnswerOptions {
  finishReason?: string | undefined;
  outputTokens?: number | undefined;
}

export type ParseVerifyAnswerResult =
  | { ok: true; verdicts: FindingVerdict[] }
  | { ok: false; error: string; code: ParseVerifyErrorCode };



export function parseVerifyAnswer(
  text: string,
  options?: ParseVerifyAnswerOptions,
): ParseVerifyAnswerResult {
  if (!text || text.trim().length === 0) {
    return { ok: false, code: 'empty-response', error: 'empty-response: model returned no text' };
  }

  const { candidates, hasUnclosedObject } = extractCandidateObjects(text);

  let firstParseError: string | null = null;
  let matchedAnswer: z.infer<typeof VerifyAnswerLooseSchema> | null = null;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = parseJsonLenient(candidate);
    } catch (err) {
      if (!firstParseError) {
        firstParseError = err instanceof Error ? err.message : String(err);
      }
      continue;
    }

    const loose = VerifyAnswerLooseSchema.safeParse(parsed);
    if (loose.success) {
      matchedAnswer = loose.data;
      break;
    } else if (!firstParseError) {
      firstParseError = loose.error.message;
    }
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
      error: `invalid-json: ${firstParseError ?? 'no valid JSON object found matching verify schema'}`,
    };
  }

  const verdicts: FindingVerdict[] = [];
  for (const rawVerdict of matchedAnswer.verdicts) {
    const result = FindingVerdictSchema.safeParse(rawVerdict);
    if (result.success) verdicts.push(result.data);
  }

  return { ok: true, verdicts };
}

// ---------------------------------------------------------------------------
// Apply Verdicts
// ---------------------------------------------------------------------------

/** Highest confidence a finding resting on code that was not shown can keep (ADR-0028). */
export const UNSHOWN_CODE_MAX_CONFIDENCE = 0.69;

export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

/** A finding the verifier rejected, as the review summary lists it (ADR-0028). */
export interface VerifyRejectedFinding {
  title: string;
  path: string;
  line: number;
}

export interface ApplyVerdictsResult {
  kept: Finding[];
  rejected: RejectedFinding[];
}

export function applyVerdicts(
  findings: Finding[],
  verdicts: FindingVerdict[],
): ApplyVerdictsResult {
  const verdictMap = new Map<string, FindingVerdict>();
  for (const v of verdicts) verdictMap.set(v.id, v);

  const kept: Finding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const finding of findings) {
    // Security findings created from secret redaction are never sent for verification and always kept
    if (
      finding.id.startsWith('sec') ||
      finding.evidence.startsWith('[REDACTED:') ||
      finding.title === 'Secret detected in patch'
    ) {
      kept.push(finding);
      continue;
    }

    const verdict = verdictMap.get(finding.id);
    if (!verdict) {
      kept.push(finding);
    } else if (verdict.verdict === 'rejected') {
      rejected.push({ finding, reason: verdict.reason });
    } else if (verdict.verdict === 'plausible') {
      kept.push({ ...finding, confidence: Math.min(finding.confidence, UNSHOWN_CODE_MAX_CONFIDENCE) });
    } else {
      kept.push(finding);
    }
  }

  return { kept, rejected };
}
