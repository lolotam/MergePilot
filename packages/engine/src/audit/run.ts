import { z } from 'zod';
import type { TokenUsage } from '../llm/types.js';
import { FINDINGS_MISSING_REASON, parseReviewAnswer, ReviewAnswerSchema } from '../review/answer.js';
import { estimateTokens } from '../review/budget.js';
import { secretsToRedact } from '../review/model.js';
import { needsTruncationRetry } from '../review/split.js';
import { describeCallError, requestedOutputTokens, SpendTracker } from '../review/spend.js';
import type { Finding } from '../review/types.js';
import { redactSecrets } from '../security/redact.js';
import { selectFindings } from '../validate/select.js';
import { planAudit } from './plan.js';
import { buildAuditPrompt } from './prompt.js';
import type {
  AuditResult,
  ChunkSummary,
  FailedChunk,
  RunAuditInput,
} from './types.js';

const AUDIT_MAX_OUTPUT_TOKENS = 4096;
const AUDIT_RETRY_OUTPUT_TOKENS = AUDIT_MAX_OUTPUT_TOKENS * 2;

function addUsage(total: TokenUsage, usage: TokenUsage | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens ?? 0;
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
}

export async function runAudit(input: RunAuditInput): Promise<AuditResult> {
  const {
    config,
    rulesFiles,
    readFile,
    files,
    model,
    signal,
  } = input;
  // Keys the model (and its fallbacks) send are redacted too, not only the caller's list.
  const knownSecrets = secretsToRedact(input.knownSecrets ?? [], model);

  const plan = planAudit({
    files: files.map((f) => ({ path: f.path, size: f.size ?? 0 })),
    include: config.audit?.include,
    exclude: config.audit?.exclude,
    maxFiles: config.audit?.maxFiles,
    maxInputTokens: config.budget?.maxInputTokens ?? 200000,
  });

  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  if (plan.chunks.length === 0) {
    return {
      findings: [],
      summaryByChunk: [],
      skipped: plan.skipped,
      usage: totalUsage,
      failedChunks: [],
    };
  }

  const redactedRulesFiles = rulesFiles.map((rf) => ({
    path: rf.path,
    content: redactSecrets(rf.content, knownSecrets).text,
  }));

  const securityFindings: Finding[] = [];
  let secFindingIdx = 1;
  const parsedFindings: Finding[] = [];
  const summaryByChunk: ChunkSummary[] = [];

  const responseSchema = z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>;
  // Output tokens each call really requests: answer budget + the model's thinking headroom.
  const firstRequested = requestedOutputTokens(model, AUDIT_MAX_OUTPUT_TOKENS);
  const retryRequested = requestedOutputTokens(model, AUDIT_RETRY_OUTPUT_TOKENS);

  for (let i = 0; i < plan.chunks.length; i++) {
    const chunkPaths = plan.chunks[i]!;

    try {
      const chunkFiles: Array<{ path: string; content: string }> = [];

      for (const filePath of chunkPaths) {
        const rawContent = await readFile(filePath);
        const redactResult = redactSecrets(rawContent, knownSecrets);
        chunkFiles.push({ path: filePath, content: redactResult.text });

        for (const finding of redactResult.found) {
          securityFindings.push({
            id: `sec${secFindingIdx++}`,
            path: filePath,
            line: finding.line,
            side: 'RIGHT',
            title: 'Secret detected in file',
            body: `A secret of kind "${finding.kind}" was detected and redacted before audit.`,
            severity: 'high',
            category: 'security',
            evidence: `[REDACTED:${finding.kind}]`,
            confidence: 1,
          });
        }
      }

      const prompt = buildAuditPrompt({
        language: config.language,
        rulesFiles: redactedRulesFiles,
        files: chunkFiles,
      });

      const promptTokens = estimateTokens(prompt.system + prompt.user);
      // Each chunk is one review-sized unit: its calls together stay within perReviewUsd.
      const spend = new SpendTracker(config.budget?.pricing, config.budget?.perReviewUsd ?? Infinity);
      const modelResponse = await model.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: AUDIT_MAX_OUTPUT_TOKENS,
        responseSchema,
        ...(signal ? { signal } : {}),
      });
      spend.record(promptTokens, firstRequested, modelResponse.usage);
      addUsage(totalUsage, modelResponse.usage);

      let parseResult = parseReviewAnswer(modelResponse.text, {
        finishReason: modelResponse.finishReason,
        outputTokens: modelResponse.usage?.outputTokens,
      });
      const retryNotes: string[] = [];

      if (needsTruncationRetry(parseResult, modelResponse.finishReason)) {
        if (!spend.canAfford(promptTokens, retryRequested)) {
          retryNotes.push('truncation retry skipped: budget limit reached');
        } else {
          try {
            const retryResponse = await model.generate({
              system: prompt.system,
              user: prompt.user,
              maxOutputTokens: AUDIT_RETRY_OUTPUT_TOKENS,
              responseSchema,
              ...(signal ? { signal } : {}),
            });
            spend.record(promptTokens, retryRequested, retryResponse.usage);
            addUsage(totalUsage, retryResponse.usage);
            parseResult = parseReviewAnswer(retryResponse.text, {
              finishReason: retryResponse.finishReason,
              outputTokens: retryResponse.usage?.outputTokens,
            });
          } catch (err) {
            retryNotes.push(`truncation retry failed: ${describeCallError(err, knownSecrets)}`);
          }
        }
      }

      // An audit chunk answered without a findings list was not audited: it is a failed chunk,
      // never "No findings" (ADR-0011 amendment).
      if (parseResult.ok && parseResult.findingsMissing) {
        parseResult = { ok: false, code: 'invalid-json', error: FINDINGS_MISSING_REASON };
      }

      if (!parseResult.ok && retryNotes.length > 0) {
        parseResult = { ...parseResult, error: [parseResult.error, ...retryNotes].join('; ') };
      }

      if (!parseResult.ok) {
        summaryByChunk.push({
          chunkIndex: i,
          paths: chunkPaths,
          error: parseResult.error,
        });
      } else {
        summaryByChunk.push({
          chunkIndex: i,
          paths: chunkPaths,
          summary: parseResult.summary,
        });
        parsedFindings.push(...parseResult.findings);
      }
    } catch (err) {
      const errorMsg = describeCallError(err, knownSecrets);
      summaryByChunk.push({
        chunkIndex: i,
        paths: chunkPaths,
        error: errorMsg,
      });
    }
  }

  const reNumberedParsedFindings = parsedFindings.map((f, idx) => ({
    ...f,
    id: `f${idx + 1}`,
  }));

  const allFindings = [...securityFindings, ...reNumberedParsedFindings];

  const maxFindingsCap = Math.min(
    50,
    (config.review?.maxFindings ?? 5) * plan.chunks.length,
  );

  const selected = selectFindings(allFindings, {
    maxFindings: maxFindingsCap,
    minSeverity: config.review?.minSeverity,
  });

  const failedChunks: FailedChunk[] = summaryByChunk
    .filter((c): c is ChunkSummary & { error: string } => typeof c.error === 'string')
    .map((c) => ({
      chunkIndex: c.chunkIndex,
      paths: c.paths,
      error: c.error,
    }));

  return {
    findings: selected,
    summaryByChunk,
    skipped: plan.skipped,
    usage: totalUsage,
    failedChunks,
  };
}
