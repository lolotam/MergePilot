/**
 * Use case 2 (ADR-0015): the semantic duplicate check. The caller (dedupe) pairs each new finding
 * with existing MergePilot comments nearby; every pair becomes one `noul` question in a single
 * request, and pairs at or above the threshold are duplicates. A failed judge drops nothing.
 */
import type { Secret } from '../credentials/secret.js';
import { JudgeUnavailableError, judgeFailureCode, type Judge } from './judge.js';
import { noul, untrustedText } from './questions.js';
import type { JudgeJson, JudgeQuestion } from './types.js';

export const SAME_ISSUE_THRESHOLD = 0.8;

export interface SameIssuePair {
  /** Caller's key for the pair; returned in `duplicates`. */
  key: string;
  newComment: { path: string; line: number; title: string; body: string };
  existingComment: { path: string; line: number; body: string };
}

export interface SameIssueInput {
  judge: Judge;
  pairs: readonly SameIssuePair[];
  knownSecrets: readonly Secret[];
  threshold?: number | undefined;
  signal?: AbortSignal | undefined;
  maxUsd?: number | undefined;
}

export interface SameIssueOutcome {
  /** Keys of the pairs judged to describe the same issue. */
  duplicates: Set<string>;
  checked: number;
  unavailable?: string | undefined;
}

const CRITERIA = {
  true: 'Both comments point out the same underlying problem, even if worded differently.',
  false: 'The comments describe different problems.',
};

export async function judgeSameIssue(input: SameIssueInput): Promise<SameIssueOutcome> {
  const threshold = input.threshold ?? SAME_ISSUE_THRESHOLD;
  if (input.pairs.length === 0) return { duplicates: new Set(), checked: 0 };
  const text = (value: string, max: number): string => untrustedText(value, input.knownSecrets, max);

  const state: Record<string, JudgeJson> = {};
  const questions: Record<string, JudgeQuestion> = {};
  input.pairs.forEach((pair, index) => {
    const id = `p${index + 1}`;
    state[id] = {
      new: {
        path: text(pair.newComment.path, 300),
        line: pair.newComment.line,
        title: text(pair.newComment.title, 500),
        body: text(pair.newComment.body, 2000),
      },
      existing: {
        path: text(pair.existingComment.path, 300),
        line: pair.existingComment.line,
        body: text(pair.existingComment.body, 2500),
      },
    };
    questions[id] = noul(
      `Do the review comments \`pairs.${id}.new\` and \`pairs.${id}.existing\` describe the same issue?`,
      CRITERIA,
    );
  });

  try {
    const decision = await input.judge.decide({
      state: { pairs: state },
      questions,
      signal: input.signal,
      maxUsd: input.maxUsd,
    });
    const duplicates = new Set<string>();
    input.pairs.forEach((pair, index) => {
      const answer = decision.answers[`p${index + 1}`];
      if (answer?.type === 'noul' && answer.noul >= threshold) duplicates.add(pair.key);
    });
    return { duplicates, checked: input.pairs.length };
  } catch (error) {
    const code = error instanceof JudgeUnavailableError ? error.code : judgeFailureCode(error);
    return { duplicates: new Set(), checked: 0, unavailable: code };
  }
}
