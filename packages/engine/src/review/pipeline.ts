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
import { parsePatch, type ParsedPatch } from '../diff/parse-patch.js';
import type { LlmFailure } from '../llm/failure.js';
import type { TokenUsage } from '../llm/types.js';
import { redactSecrets } from '../security/redact.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { anchorFindings } from '../validate/anchor.js';
import { selectFindings } from '../validate/select.js';
import { parseReviewAnswer } from './answer.js';
import { ReviewAnswerSchema } from './answer.js';
import { checkBudget, estimateTokens } from './budget.js';
import { estimateCostUsd } from '../budget/cost.js';
import { FallbackChain, type FallbackDisclosure } from './fallback.js';
import { secretsToRedact, type ReviewModel } from './model.js';
import { buildReviewPrompt, type LibraryDoc } from './prompt.js';
import type { Finding, ReviewResult, Severity } from './types.js';
import {
  makeRedactionFinding,
  buildPatchLineToNewLineMap,
} from './patch-helpers.js';
import { recoverReviewTruncation } from './split.js';
import { SpendTracker } from './spend.js';
import { runVerifyPass, VERIFY_MAX_OUTPUT_TOKENS } from './verify-pass.js';

// ── Input types ──

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
  /** Optional full PR files to anchor inline findings to PR patch lines (used during incremental review). */
  anchorFiles?: PrFile[] | undefined;
  rulesFiles: RulesFile[];
  model: ReviewModel;
  /** Explicit fallback models (ADR-0008); defaults to `model.fallbacks`, else none. */
  fallbackModels?: readonly ReviewModel[] | undefined;
  knownSecrets: Secret[];
  libraryDocs?: LibraryDoc[] | undefined;
  signal?: AbortSignal | undefined;
}

// ── Output types ──

export type ReviewRunResult =
  | ({
      status: 'completed';
      summary: string;
      inline: Finding[];
      summaryOnly: Finding[];
      result: ReviewResult;
      usage?: TokenUsage | undefined;
      costUsd?: number | undefined;
      droppedInvalid: number;
      complete: boolean;
      verification?: { checked: number; rejected: number } | undefined;
    } & Partial<FallbackDisclosure>)
  | { status: 'skipped-budget'; reason: string }
  | ({
      status: 'failed';
      reason: string;
      /** Provider message, already secret-redacted by the adapter; for logs and the summary. */
      detail?: string | undefined;
    } & Partial<FallbackDisclosure>);

// ── Pipeline ──

/**
 * Runs the full single-pass review pipeline described in PRD v0.2 §7 steps 2–8.
 */
export async function runReview(input: RunReviewInput): Promise<ReviewRunResult> {
  const { config, pr, files, rulesFiles, signal } = input;
  // One chain per review, so a fallback lasts for the rest of this review only (ADR-0008).
  const fallbackModels = input.fallbackModels ?? input.model.fallbacks ?? [];
  const model = new FallbackChain(input.model, fallbackModels);
  // Every key a model in the chain may send is redacted before ANY model call, fallbacks included.
  const knownSecrets = secretsToRedact(input.knownSecrets, input.model, fallbackModels);
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
    ...(input.libraryDocs ? { libraryDocs: input.libraryDocs } : {}),
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
  // Price the output limit each call really requests: answer budget + effort's thinking headroom
  // (largest across the chain). Thinking is billed as output, so pricing less could overspend.
  const reviewOutputTokens = model.outputTokensFor(maxOutputTokens);
  const verifyOutputTokens = model.outputTokensFor(VERIFY_MAX_OUTPUT_TOKENS);
  let estimatedCostUsd: number | undefined;
  if (budgetCfg.pricing) {
    estimatedCostUsd = estimateCostUsd(
      { inputTokens: promptTokens, maxOutputTokens: reviewOutputTokens },
      budgetCfg.pricing,
    );
    if (reviewCfg.verify) {
      // Worst case for the verification call: its hunks are a subset of the review prompt.
      estimatedCostUsd += estimateCostUsd(
        { inputTokens: promptTokens, maxOutputTokens: verifyOutputTokens },
        budgetCfg.pricing,
      );
    }
    if (estimatedCostUsd > budgetCfg.perReviewUsd) {
      return {
        status: 'skipped-budget',
        reason: `estimated $${estimatedCostUsd.toFixed(2)} > limit $${budgetCfg.perReviewUsd.toFixed(2)}`,
      };
    }
  }

  // Real spend across every call of this review; usage-less calls count at their estimate.
  const spend = new SpendTracker(budgetCfg.pricing, budgetCfg.perReviewUsd);

  // ── Step d: call the model ─────────────────────────────────────────────
  let totalUsage: TokenUsage | undefined;
  let modelResponse: Awaited<ReturnType<typeof model.generate>>;
  try {
    modelResponse = await model.generate({
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens,
      responseSchema: z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
    totalUsage = modelResponse.usage;
    spend.record(promptTokens, reviewOutputTokens, modelResponse.usage);
  } catch (err) {
    const failure = err as LlmFailure;
    const disclosure = model.disclosure();
    if (failure && typeof failure === 'object' && 'code' in failure) {
      const detail = redactSecrets(String(failure.message ?? ''), knownSecrets).text.slice(0, 500);
      return { status: 'failed', reason: failure.code as string, ...(detail ? { detail } : {}), ...disclosure };
    }
    return { status: 'failed', reason: String(err), ...disclosure };
  }

  // ── Step e: parse answer + truncation recovery ─────────────────────────
  let parseResult = parseReviewAnswer(modelResponse.text, {
    finishReason: modelResponse.finishReason,
    outputTokens: modelResponse.usage?.outputTokens,
  });

  const recovery = await recoverReviewTruncation({
    parseResult,
    modelResponse,
    prompt,
    promptTokens,
    maxOutputTokens,
    reviewOutputTokens,
    model,
    config,
    spend,
    knownSecrets,
    redactedPrTitle,
    redactedPrBody,
    redactedRulesFiles,
    redactedReviewableFiles,
    libraryDocs: input.libraryDocs,
    signal,
    totalUsage,
  });
  parseResult = recovery.parseResult;
  totalUsage = recovery.totalUsage;
  incompleteReasons.push(...recovery.incompleteReasons);

  if (!parseResult.ok) {
    // Skipped or failed recovery steps are disclosed alongside the parse error.
    const detail = recovery.incompleteReasons.join('; ');
    return { status: 'failed', reason: parseResult.error, ...(detail ? { detail } : {}), ...model.disclosure() };
  }

  // ── Step e2: verification pass ─────────────────────────────────────────
  let modelFindings = parseResult.findings;
  let verification: { checked: number; rejected: number } | undefined;

  if (reviewCfg.verify && modelFindings.length > 0) {
    const verified = await runVerifyPass({
      language: config.language,
      findings: modelFindings,
      files: redactedReviewableFiles,
      model,
      spend,
      knownSecrets,
      totalUsage,
      signal,
    });
    modelFindings = verified.findings;
    totalUsage = verified.totalUsage;
    verification = verified.verification;
    incompleteReasons.push(...verified.incompleteReasons);
  }

  // ── Step f: select + anchor ────────────────────────────────────────────
  const allFindings = [...securityFindings, ...modelFindings];

  const selected = selectFindings(allFindings, {
    maxFindings: reviewCfg.maxFindings,
    minSeverity: reviewCfg.minSeverity as Severity,
  });

  // Build patch index for anchoring. An incremental review passes the full PR diff as
  // `anchorFiles`: inline comments must land on lines of the PR's own patch, and only on its
  // RIGHT side (the reviewed patch's LEFT lines belong to the previous head, not the PR base).
  const anchorSource = input.anchorFiles ?? redactedReviewableFiles;
  const patchIndex = new Map<string, ParsedPatch>();
  for (const f of anchorSource) {
    if (!f.patch) continue;
    const parsed = parsePatch(f.patch);
    patchIndex.set(f.path, input.anchorFiles ? { ...parsed, leftLines: new Set<number>() } : parsed);
  }

  const { inline, summaryOnly } = anchorFindings(selected, patchIndex);

  // ── Step g: assemble result ────────────────────────────────────────────
  const complete = incompleteReasons.length === 0;

  const result: ReviewResult = {
    summary: parseResult.summary,
    findings: selected,
    complete,
    incompleteReasons,
  };

  // Pricing belongs to the configured model; after a fallback the cost is unknown (tokens still count).
  const disclosure = model.disclosure();
  let reviewCostUsd: number | undefined;
  if (budgetCfg.pricing && !disclosure.fallbackFrom) {
    // Real cost where usage was reported, the estimate for calls without usage (ADR-0011).
    reviewCostUsd = spend.spentUsd;
  }

  return {
    status: 'completed',
    summary: parseResult.summary,
    inline,
    summaryOnly,
    result,
    usage: totalUsage,
    ...(reviewCostUsd !== undefined ? { costUsd: reviewCostUsd } : {}),
    droppedInvalid: parseResult.droppedInvalid,
    complete,
    ...(verification !== undefined ? { verification } : {}),
    ...disclosure,
  };
}
