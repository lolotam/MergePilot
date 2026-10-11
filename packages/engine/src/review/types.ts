import { z } from 'zod';

/**
 * Shared review contracts. Every engine module and every shell builds against
 * these shapes, so a change here is an architectural change (docs/architecture.md §4).
 */

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingCategorySchema = z.enum([
  'correctness',
  'security',
  'data-loss',
  'project-rule',
  'library-usage',
  'performance',
  'maintainability',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/** A side of the diff a comment anchors to, matching GitHub's review API. */
export const DiffSideSchema = z.enum(['LEFT', 'RIGHT']);
export type DiffSide = z.infer<typeof DiffSideSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: DiffSideSchema.default('RIGHT'),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: SeveritySchema,
  category: FindingCategorySchema,
  /** The code or rule text that proves the finding. A finding without evidence is dropped. */
  evidence: z.string().min(1),
  suggestion: z.string().optional(),
  /** Pointer to the project rule this finding enforces, e.g. "CLAUDE.md §5". */
  ruleRef: z.string().optional(),
  /** Model-reported triage signal in [0, 1]; never a proven probability. */
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingSchema),
  /** False when part of the diff could not be reviewed (truncated patch, budget stop). */
  complete: z.boolean(),
  incompleteReasons: z.array(z.string()).default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
