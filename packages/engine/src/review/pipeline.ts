/**
 * The review pipeline: classify → redact → build prompt → budget check → model call →
 * parse answer → select + anchor findings → return result.
 *
 * Pure engine code: no GitHub calls, no filesystem access, no network.
 * Everything arrives through `RunReviewInput` (ADR-0001).
 */

import { z } from 'zod';
import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import { classifyFile } from '../diff/classify-file.js';
import { parsePatch } from '../diff/parse-patch.js';
import type { LlmFailure } from '../llm/failure.js';
import type { TokenUsage } from '../llm/types.js';
import { redactSecrets } from '../security/redact.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { anchorFindings } from '../validate/anchor.js';
import { selectFindings } from '../validate/select.js';
import { parseReviewAnswer } from './answer.js';
import { ReviewAnswerSchema } from './answer.js';
import { checkBudget, estimateTokens } from './budget.js';
import { costUsd, estimateCostUsd } from '../budget/cost.js';
import type { ReviewModel } from './model.js';
import { buildReviewPrompt } from './prompt.js';
import type { Finding, ReviewResult, Severity } from './types.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface PrFile {
  path: string;
  status: string;
  patch?: string | undefined;
  changes: number;
}

export interface RulesFile {
  path: string;
  content: string;
}

export interface RunReviewInput {
  config: MergePilotConfig;
  pr: { title: string; body: string };
  files: PrFile[];
  rulesFiles: RulesFile[];
  model: ReviewModel;
  knownSecrets: Secret[];
  signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ReviewRunResult =
  | {
      status: 'completed';
      summary: string;
      inline: Finding[];
      summaryOnly: Finding[];
      result: ReviewResult;
      usage?: TokenUsage | undefined;
      costUsd?: number | undefined;
      droppedInvalid: number;
      complete: boolean;
    }
  | { status: 'skipped-budget'; reason: string }
  | { status: 'failed'; reason: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Builds a security Finding for a redacted secret on an added line. */
function makeRedactionFinding(
  path: string,
  line: number,
  kind: string,
  idIndex: number,
): Finding {
  return {
    id: `sec${idIndex}`,
    path,
    line,
    side: 'RIGHT',
    title: 'Secret detected in patch',
    body: `A secret of kind "${kind}" was detected in this added line and redacted before review.`,
    severity: 'high',
    category: 'security',
    evidence: `[REDACTED:${kind}]`,
    confidence: 1,
  };
}

/**
 * Builds a map from 1-based patch-text line number → new-side file line number
 * for every added or context line in the patch. Used to correlate `redactSecrets`
 * findings (which use patch-text line numbers) with file line numbers.
 */
function buildPatchLineToNewLineMap(patch: string): Map<number, number> {
  const result = new Map<number, number>();
  const lines = patch.split('\n');
  let patchLineNum = 1; // 1-based line number within the patch text
  let newLine = 0;
  const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(HUNK_RE);
      if (m) {
        newLine = parseInt(m[1] ?? '1', 10);
      }
      patchLineNum++;
      continue;
    }
    if (line.startsWith('+')) {
      result.set(patchLineNum, newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      // removed lines don't have a new-side line number
    } else if (line.startsWith(' ')) {
      result.set(patchLineNum, newLine);
      newLine++;
    }
    patchLineNum++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full single-pass review pipeline described in PRD v0.2 §7 steps 2–8.
 */
export async function runReview(input: RunReviewInput): Promise<ReviewRunResult> {
  const { config, pr, files, rulesFiles, model, knownSecrets, signal } = input;
  const reviewCfg = config.review;
  const budgetCfg = config.budget;

  // ── Step a: classify files ─────────────────────────────────────────────
  const incompleteReasons: string[] = [];
  const reviewableFiles: Array<{ path: string; patch: string }> = [];

  for (const file of files) {
    const classification = classifyFile(file, {
      exclude: reviewCfg.exclude,
      isSensitivePath,
    });

    if (classification === 'incomplete-truncated') {
      incompleteReasons.push(`${file.path}: patch truncated`);
    } else if (classification === 'review' && file.patch) {
      reviewableFiles.push({ path: file.path, patch: file.patch });
    }
  }

  // ── Step b: redact secrets ─────────────────────────────────────────────
  const securityFindings: Finding[] = [];
  let secFindingIdx = 1;

  // Redact PR text
  const redactedPrTitle = redactSecrets(pr.title, knownSecrets).text;
  const redactedPrBody = redactSecrets(pr.body, knownSecrets).text;

  // Redact rules files
  const redactedRulesFiles = rulesFiles.map((rf) => ({
    path: rf.path,
    content: redactSecrets(rf.content, knownSecrets).text,
  }));

  // Redact patches and collect security findings for added lines
  const redactedReviewableFiles: Array<{ path: string; patch: string }> = [];

  for (const rf of reviewableFiles) {
    const redactResult = redactSecrets(rf.patch, knownSecrets);
    redactedReviewableFiles.push({ path: rf.path, patch: redactResult.text });

    // Build a map from patch-text line# → new-side file line# so we can correlate
    // redactSecrets findings (patch-text line numbers) with actual file line numbers.
    const patchLineToNewLine = buildPatchLineToNewLineMap(rf.patch);
    // Parse original patch to know which new-side lines are "added"
    const parsed = parsePatch(rf.patch);

    for (const finding of redactResult.found) {
      const newSideLine = patchLineToNewLine.get(finding.line);
      // Only emit a finding if the redacted line is an added line on the new side
      if (newSideLine !== undefined && parsed.addedLines.has(newSideLine)) {
        securityFindings.push(
          makeRedactionFinding(rf.path, newSideLine, finding.kind, secFindingIdx++),
        );
      }
    }
  }

  // ── Step c: build prompt + budget check ───────────────────────────────
  const prompt = buildReviewPrompt({
    language: config.language,
    maxFindings: reviewCfg.maxFindings,
    pr: { title: redactedPrTitle, body: redactedPrBody },
    rulesFiles: redactedRulesFiles,
    pathInstructions: reviewCfg.pathInstructions,
    files: redactedReviewableFiles,
  });

  const promptTokens = estimateTokens(prompt.system + prompt.user);
  const budgetResult = checkBudget({
    promptTokens,
    maxInputTokens: budgetCfg.maxInputTokens,
  });

  if (!budgetResult.ok) {
    return { status: 'skipped-budget', reason: budgetResult.reason };
  }

  const maxOutputTokens = 4096;
  let estimatedCostUsd: number | undefined;
  if (budgetCfg.pricing) {
    estimatedCostUsd = estimateCostUsd(
      { inputTokens: promptTokens, maxOutputTokens },
      budgetCfg.pricing,
    );
    if (estimatedCostUsd > budgetCfg.perReviewUsd) {
      return {
        status: 'skipped-budget',
        reason: `estimated $${estimatedCostUsd.toFixed(2)} > limit $${budgetCfg.perReviewUsd.toFixed(2)}`,
      };
    }
  }

  // ── Step d: call the model ─────────────────────────────────────────────
  let modelResponse: Awaited<ReturnType<typeof model.generate>>;
  try {
    modelResponse = await model.generate({
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens,
      responseSchema: z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    const failure = err as LlmFailure;
    if (failure && typeof failure === 'object' && 'code' in failure) {
      return { status: 'failed', reason: failure.code as string };
    }
    return { status: 'failed', reason: String(err) };
  }

  // ── Step e: parse answer ───────────────────────────────────────────────
  const parseResult = parseReviewAnswer(modelResponse.text);
  if (!parseResult.ok) {
    return { status: 'failed', reason: parseResult.error };
  }

  // ── Step f: select + anchor ────────────────────────────────────────────
  const allFindings = [...securityFindings, ...parseResult.findings];

  const selected = selectFindings(allFindings, {
    maxFindings: reviewCfg.maxFindings,
    minSeverity: reviewCfg.minSeverity as Severity,
  });

  // Build patch index for anchoring
  const patchIndex = new Map(
    redactedReviewableFiles
      .filter((f) => f.patch)
      .map((f) => [f.path, parsePatch(f.patch)]),
  );

  const { inline, summaryOnly } = anchorFindings(selected, patchIndex);

  // ── Step g: assemble result ────────────────────────────────────────────
  const complete = incompleteReasons.length === 0;

  const result: ReviewResult = {
    summary: parseResult.summary,
    findings: selected,
    complete,
    incompleteReasons,
  };

  let reviewCostUsd: number | undefined;
  if (budgetCfg.pricing) {
    reviewCostUsd = modelResponse.usage
      ? costUsd(modelResponse.usage, budgetCfg.pricing)
      : (estimatedCostUsd ??
        estimateCostUsd({ inputTokens: promptTokens, maxOutputTokens }, budgetCfg.pricing));
  }

  return {
    status: 'completed',
    summary: parseResult.summary,
    inline,
    summaryOnly,
    result,
    usage: modelResponse.usage,
    ...(reviewCostUsd !== undefined ? { costUsd: reviewCostUsd } : {}),
    droppedInvalid: parseResult.droppedInvalid,
    complete,
  };
}
