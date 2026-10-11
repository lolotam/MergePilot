import type { MergePilotConfig } from '../config/schema.js';
import type { LlmFailure } from '../llm/failure.js';
import type { TokenUsage } from '../llm/types.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';

export function makeConfig(overrides: Partial<MergePilotConfig> = {}): MergePilotConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    language: 'en',
    review: {
      maxFindings: 5,
      minSeverity: 'medium',
      exclude: ['**/*.lock'],
      rulesFiles: ['CLAUDE.md'],
      pathInstructions: [],
    },
    budget: {
      perReviewUsd: 0.5,
      maxInputTokens: 200000,
    },
    audit: {
      enabled: false,
    },
    ...overrides,
  };
}

export function validFindingJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/index.ts',
    line: 10,
    side: 'RIGHT',
    title: 'Potential null deref',
    body: 'x could be null',
    severity: 'high',
    category: 'correctness',
    evidence: 'x.doSomething()',
    confidence: 0.9,
    ...overrides,
  };
}

export function makeAnswerJson(findings: Record<string, unknown>[] = [validFindingJson()]): string {
  return JSON.stringify({ summary: 'Looks good.', findings });
}

export function makeModel(
  response: string | (() => Promise<ReviewModelResponse>),
  usage?: TokenUsage,
): ReviewModel {
  return {
    label: 'fake:test',
    generate: async (_req: ReviewModelRequest): Promise<ReviewModelResponse> => {
      if (typeof response === 'function') {
        return response();
      }
      return {
        text: response,
        ...(usage ? { usage } : {}),
        finishReason: 'stop',
      };
    },
  };
}

export function makeFailingModel(failure: LlmFailure): ReviewModel {
  return {
    label: 'fake:fail',
    generate: async () => {
      throw failure;
    },
  };
}

export const SIMPLE_PATCH = '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;';
