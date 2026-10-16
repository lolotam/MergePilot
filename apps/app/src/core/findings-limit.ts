/**
 * The workspace's findings limit per published review, offered as a dropdown (ADR-0033). A
 * repository's `.mergepilot.yml` `review.maxFindings` (1-50) overrides it.
 */
export const MAX_FINDINGS_CHOICES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as const;
export type MaxFindingsChoice = (typeof MAX_FINDINGS_CHOICES)[number];
export const DEFAULT_WORKSPACE_MAX_FINDINGS: MaxFindingsChoice = 5;
