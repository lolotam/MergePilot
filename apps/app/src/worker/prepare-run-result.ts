import {
  redactSecrets,
  type Finding,
  type Secret,
  type TokenUsage,
} from '@mergepilot/engine';
import type { ReviewRunFinding, ReviewRunResultPayload } from '../core/types.js';

export interface PrepareRunResultInput {
  summary: string;
  inlineFindings: Finding[];
  summaryOnlyFindings?: Finding[] | undefined;
  language: 'ar' | 'en';
  usage?: TokenUsage | undefined;
  verification?: { checked: number; rejected: number } | undefined;
  knownSecrets?: Secret[] | undefined;
}

const MAX_FINDINGS = 200;
const MAX_BYTES = 200 * 1024; // 200 KB

function extractHighlights(summary: string): string[] {
  const highlights: string[] = [];
  const lines = summary.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
      const item = trimmed.slice(2).trim();
      if (item.length > 0) {
        highlights.push(item);
      }
    }
  }
  return highlights;
}

function mapFinding(f: Finding, secrets: Secret[]): ReviewRunFinding {
  return {
    path: f.path,
    line: f.line,
    severity: f.severity,
    category: f.category,
    title: redactSecrets(f.title, secrets).text,
    body: redactSecrets(f.body, secrets).text,
    ...(f.suggestion ? { suggestion: redactSecrets(f.suggestion, secrets).text } : {}),
  };
}

export function prepareRunResult(input: PrepareRunResultInput): ReviewRunResultPayload {
  const secrets = input.knownSecrets ?? [];

  const rawSummary = redactSecrets(input.summary, secrets).text;
  const rawHighlights = extractHighlights(input.summary).map(
    (h) => redactSecrets(h, secrets).text,
  );

  let inlineMapped = (input.inlineFindings ?? []).map((f) => mapFinding(f, secrets));
  let outOfDiffMapped = (input.summaryOnlyFindings ?? []).map((f) => mapFinding(f, secrets));

  // Cap findings count at 200 total
  const totalFindingsCount = inlineMapped.length + outOfDiffMapped.length;
  if (totalFindingsCount > MAX_FINDINGS) {
    if (inlineMapped.length >= MAX_FINDINGS) {
      inlineMapped = inlineMapped.slice(0, MAX_FINDINGS);
      outOfDiffMapped = [];
    } else {
      const remainingSlots = MAX_FINDINGS - inlineMapped.length;
      outOfDiffMapped = outOfDiffMapped.slice(0, remainingSlots);
    }
  }

  const payload: ReviewRunResultPayload = {
    v: 1,
    summary: rawSummary,
    highlights: rawHighlights,
    findings: inlineMapped,
    ...(outOfDiffMapped.length > 0 ? { outOfDiff: outOfDiffMapped } : {}),
    language: input.language,
    ...(input.usage
      ? {
          usage: {
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
          },
        }
      : {}),
    ...(input.verification
      ? {
          verify: {
            dropped: input.verification.rejected,
          },
        }
      : {}),
  };

  // Enforce 200 KB size cap
  let json = JSON.stringify(payload);
  let bytes = Buffer.byteLength(json, 'utf8');

  if (bytes > MAX_BYTES) {
    const truncateThresholds = [500, 250, 100, 40];
    for (const maxLen of truncateThresholds) {
      for (const f of payload.findings) {
        if (f.body.length > maxLen) {
          f.body = `${f.body.slice(0, maxLen)}...`;
          f.truncated = true;
        }
      }
      if (payload.outOfDiff) {
        for (const f of payload.outOfDiff) {
          if (f.body.length > maxLen) {
            f.body = `${f.body.slice(0, maxLen)}...`;
            f.truncated = true;
          }
        }
      }

      json = JSON.stringify(payload);
      bytes = Buffer.byteLength(json, 'utf8');
      if (bytes <= MAX_BYTES) {
        break;
      }
    }

    if (bytes > MAX_BYTES && payload.summary.length > 1000) {
      payload.summary = `${payload.summary.slice(0, 1000)}...`;
    }
  }

  return payload;
}
