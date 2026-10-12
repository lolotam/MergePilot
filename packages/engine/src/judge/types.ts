/**
 * The TypeSafe "System One" wire format (ADR-0015): typed questions in, calibrated answers out.
 * Jev never writes prose; code owns the control flow and acts on the answers.
 */
import { z } from 'zod';

/** Instructions and state may be a string, an object or an array (nested JSON). */
export type JudgeJson = string | number | boolean | null | JudgeJson[] | { [key: string]: JudgeJson };
export type JudgeState = string | JudgeJson[] | { [key: string]: JudgeJson };
export type JudgeInstructions = string | JudgeJson[] | { [key: string]: JudgeJson };

export interface NoulQuestion {
  type: 'noul';
  instructions: JudgeInstructions;
  criteria?: { true: string; false: string } | undefined;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: JudgeInstructions;
  /** option → description (or null); at most 255 options. */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: JudgeInstructions;
  /** An ordered rubric, 2–10 levels. */
  criteria: string[];
}

export type JudgeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

const Probabilities = z.record(z.string(), z.number());

export const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
export const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: Probabilities.optional(),
  confidence: z.number().optional(),
});
export const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  legend: z.unknown().optional(),
  probabilities: Probabilities.optional(),
  confidence: z.number().optional(),
});
export const JudgeAnswerSchema = z.discriminatedUnion('type', [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema]);

export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type JudgeAnswer = z.infer<typeof JudgeAnswerSchema>;

export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One request: every question is answered in parallel from the same state. */
export interface JudgeRequest {
  state: JudgeState;
  questions: Record<string, JudgeQuestion>;
  signal?: AbortSignal | undefined;
  /** Spend still allowed for this request; an entry whose estimate exceeds it is skipped. */
  maxUsd?: number | undefined;
}

/** One provider attempt, recorded for the run detail and the `judge.call` log line. */
export interface JudgeAttempt {
  provider: string;
  model: string;
  ok: boolean;
  /** Short failure code (`rate-limited`, `auth`, `no-key`, ...); absent when ok. */
  code?: string | undefined;
  ms: number;
  /** True when the attempt was never sent (no key, budget, time budget). */
  skipped?: boolean | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface JudgeDecision {
  provider: string;
  model: string;
  /** 0 = the configured judge, n = fallback n. */
  fallbackIndex: number;
  answers: Record<string, JudgeAnswer>;
  usage: JudgeUsage;
  costUsd?: number | undefined;
  ms: number;
  /** Every attempt of this request, in order (failed and skipped ones included). */
  attempts: JudgeAttempt[];
}
