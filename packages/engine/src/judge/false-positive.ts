/**
 * Use case 1 (ADR-0015): the false-positive check, run after review and verify. One Jev request
 * per review holds one `noul` question per finding ("is this a real problem in the shown code?"),
 * and that one request serves both uses (multi-use amendment):
 * - `annotate` adds the confidence to every finding it scored;
 * - `filter` drops findings below the threshold and returns them so the summary lists them
 *   (disclosed, never silent). Critical and high are never dropped.
 * With both on, findings are filtered and every remaining one gets its confidence line. When the
 * judge is unavailable the findings come back unchanged with the failure code.
 */
import type { Secret } from '../credentials/secret.js';
import type { Finding } from '../review/types.js';
import { JudgeUnavailableError, judgeFailureCode, type Judge } from './judge.js';
import { hunkAround, noul, untrustedText } from './questions.js';
import type { JudgeAnswer, JudgeJson, JudgeQuestion } from './types.js';
import { normalizeJudgeUses, type JudgeUse, type JudgeUses } from './uses.js';

/** Severities the filter never drops, whatever Jev answers (ADR-0015). */
const NEVER_FILTERED: ReadonlySet<string> = new Set(['critical', 'high']);

export const DEFAULT_JUDGE_THRESHOLD = 0.35;

export interface FalsePositiveInput {
  judge: Judge;
  /** Only `annotate` and `filter` matter here; neither of them means no request. */
  uses: JudgeUses;
  threshold: number;
  findings: Finding[];
  /** The redacted patches the review saw. */
  files: ReadonlyArray<{ path: string; patch: string }>;
  knownSecrets: readonly Secret[];
  language: 'ar' | 'en';
  signal?: AbortSignal | undefined;
  maxUsd?: number | undefined;
}

export interface FilteredFinding {
  title: string;
  path: string;
  line: number;
  noul: number;
}

export interface FalsePositiveOutcome {
  findings: Finding[];
  /** Every configured use, in the fixed order (the summary names them). */
  uses: JudgeUse[];
  threshold: number;
  checked: number;
  filtered: FilteredFinding[];
  /** Set when every judge entry failed: the findings are unchanged. */
  unavailable?: string | undefined;
}

const CRITERIA = {
  true: 'The finding describes a real defect, risk or rule violation that is visible in the shown code.',
  false: 'The finding is wrong, speculative, a style preference, or not supported by the shown code.',
};

export function confidenceLine(noulValue: number, language: 'ar' | 'en'): string {
  const value = noulValue.toFixed(2);
  return language === 'ar' ? `<sub>ثقة Jev: ${value}</sub>` : `<sub>Jev confidence: ${value}</sub>`;
}

export async function runFalsePositiveFilter(input: FalsePositiveInput): Promise<FalsePositiveOutcome> {
  const { findings, threshold } = input;
  const uses = normalizeJudgeUses(input.uses);
  const annotate = uses.includes('annotate');
  const filter = uses.includes('filter');
  const unchanged = (unavailable?: string): FalsePositiveOutcome => ({
    findings,
    uses,
    threshold,
    checked: 0,
    filtered: [],
    ...(unavailable ? { unavailable } : {}),
  });
  if ((!annotate && !filter) || findings.length === 0) return unchanged();

  const patches = new Map(input.files.map((f) => [f.path, f.patch]));
  const state: Record<string, JudgeJson> = {};
  const questions: Record<string, JudgeQuestion> = {};
  findings.forEach((finding, index) => {
    const id = `f${index + 1}`;
    const patch = patches.get(finding.path);
    state[id] = {
      title: untrustedText(finding.title, input.knownSecrets, 500),
      body: untrustedText(finding.body, input.knownSecrets, 2000),
      severity: finding.severity,
      evidence: untrustedText(finding.evidence, input.knownSecrets, 2000),
      path: untrustedText(finding.path, input.knownSecrets, 300),
      line: finding.line,
      hunk: patch ? untrustedText(hunkAround(patch, finding.line), input.knownSecrets) : '',
    };
    questions[id] = noul(
      `Is the code-review finding in \`findings.${id}\` a real problem in the code shown in \`findings.${id}.hunk\` ` +
        `(file \`findings.${id}.path\`, line \`findings.${id}.line\`)? Judge only from the shown code.`,
      CRITERIA,
    );
  });

  let answers: Record<string, JudgeAnswer>;
  try {
    const decision = await input.judge.decide({
      state: { findings: state },
      questions,
      signal: input.signal,
      maxUsd: input.maxUsd,
    });
    answers = decision.answers;
  } catch (error) {
    return unchanged(error instanceof JudgeUnavailableError ? error.code : judgeFailureCode(error));
  }

  const kept: Finding[] = [];
  const filtered: FilteredFinding[] = [];
  findings.forEach((finding, index) => {
    const answer = answers[`f${index + 1}`];
    const value = answer?.type === 'noul' ? answer.noul : undefined;
    if (value === undefined) {
      kept.push(finding);
    } else if (filter && value < threshold && !NEVER_FILTERED.has(finding.severity)) {
      filtered.push({ title: finding.title, path: finding.path, line: finding.line, noul: value });
    } else if (annotate || (filter && value < threshold)) {
      // The filter never drops critical/high findings (the reviewed code could try to steer the
      // judge); a low score on one is shown as a confidence line instead.
      kept.push({ ...finding, body: `${finding.body}\n\n${confidenceLine(value, input.language)}` });
    } else {
      kept.push(finding);
    }
  });
  return { findings: kept, uses, threshold, checked: findings.length, filtered };
}
