import { z } from 'zod';
import type { TokenUsage } from '../llm/types.js';
import { parseReviewAnswer, ReviewAnswerSchema } from '../review/answer.js';
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

export async function runAudit(input: RunAuditInput): Promise<AuditResult> {
  const {
    config,
    rulesFiles,
    readFile,
    files,
    model,
    knownSecrets = [],
    signal,
  } = input;

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

      const modelResponse = await model.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: 4096,
        responseSchema: z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>,
        ...(signal ? { signal } : {}),
      });

      if (modelResponse.usage) {
        totalUsage.inputTokens += modelResponse.usage.inputTokens;
        totalUsage.outputTokens += modelResponse.usage.outputTokens;
        totalUsage.cacheReadTokens += modelResponse.usage.cacheReadTokens ?? 0;
        totalUsage.cacheWriteTokens += modelResponse.usage.cacheWriteTokens ?? 0;
      }

      const parseResult = parseReviewAnswer(modelResponse.text);
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
      const errorMsg = err instanceof Error ? err.message : String(err);
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
