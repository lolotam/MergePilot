import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import type { ReviewModel } from '../review/model.js';
import type { Finding } from '../review/types.js';

export interface FileEntry {
  path: string;
  size: number;
}

export interface SkippedFile {
  path: string;
  reason: 'sensitive' | 'binary' | 'excluded' | 'max-files' | string;
}

export interface PlanAuditInput {
  files: readonly FileEntry[];
  include?: readonly string[];
  exclude?: readonly string[];
  maxFiles?: number;
  maxInputTokens: number;
  isSensitivePath?: (path: string) => boolean;
}

export interface PlanAuditResult {
  chunks: string[][];
  skipped: SkippedFile[];
}

export interface AuditFile {
  path: string;
  content: string;
}

export interface AuditRulesFile {
  path: string;
  content: string;
}

export interface BuildAuditPromptInput {
  language: string;
  rulesFiles?: AuditRulesFile[];
  files: AuditFile[];
}

export interface BuiltAuditPrompt {
  system: string;
  user: string;
}

export interface ChunkSummary {
  chunkIndex: number;
  paths: string[];
  summary?: string;
  error?: string;
}

export interface FailedChunk {
  chunkIndex: number;
  paths: string[];
  error: string;
}

export interface AuditResult {
  findings: Finding[];
  summaryByChunk: ChunkSummary[];
  skipped: SkippedFile[];
  usage: TokenUsage;
  failedChunks: FailedChunk[];
}

export interface RunAuditInput {
  config: MergePilotConfig;
  rulesFiles: Array<{ path: string; content: string }>;
  readFile: (path: string) => Promise<string>;
  files: Array<{ path: string; size?: number }>;
  model: ReviewModel;
  knownSecrets?: Secret[];
  signal?: AbortSignal;
}

export interface RenderAuditReportInput {
  language: string;
  result: AuditResult;
  modelLabel?: string;
}
