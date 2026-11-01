import { redactSecrets } from '@mergepilot/engine';
import type {
  Comparison,
  ComparisonResult,
  ComparisonUpdate,
  ScanObservation,
} from '@mergepilot/webscan';
import type { WebScanOccurrenceUpdate } from './store.js';
import type { WebScanFinding } from './types.js';

/**
 * The mapping from the observation and the comparison of a run to the rows the store
 * writes.
 *
 * The package reports what it saw; the store owns how a finding and a ledger
 * transition are stored. This module is the boundary between the two.
 *
 * The evidence is redacted before it is written. The evidence of the package is built
 * from catalogue-approved facts, so it is safe by construction; the redaction is the
 * second guard that keeps a credential out of the database even when a check reports
 * something it should not.
 */

/** The findings of the scan snapshot. */
export function toScanFindings(
  observation: ScanObservation,
  comparison: ComparisonResult,
  siteId: string,
  scanId: string,
): WebScanFinding[] {
  const comparisonByOccurrence = new Map<string, Comparison>();
  for (const update of comparison.updates) {
    if (update.state !== 'archived') {
      comparisonByOccurrence.set(update.finding.occurrenceKey, update.comparison);
    }
  }
  return observation.findings.map((finding) => ({
    // The store assigns the id of the row.
    id: '',
    scanId,
    siteId,
    issueKey: finding.issueKey,
    occurrenceKey: finding.occurrenceKey,
    targetKey: finding.targetKey,
    checkId: finding.checkId,
    checkVersion: finding.checkVersion,
    issueId: finding.issueId,
    subject: finding.subject,
    severity: finding.severity,
    validation: finding.validation,
    confidence: finding.confidence,
    safeLocation: finding.safeLocation,
    evidence: redactEvidence(finding.evidence),
    evidenceHash: finding.evidenceHash,
    comparison: comparisonByOccurrence.get(finding.occurrenceKey) ?? 'New',
  }));
}

/** The ledger transitions the comparison produced. */
export function toOccurrenceUpdates(
  updates: readonly ComparisonUpdate[],
): WebScanOccurrenceUpdate[] {
  return updates.map((update) => {
    if (update.state === 'archived') {
      return {
        state: 'archived',
        identity: { ...update.identity },
        archiveReason: update.archiveReason,
      };
    }
    return {
      state: update.state,
      finding: {
        ...update.finding,
        evidence: redactEvidence(update.finding.evidence),
        comparison: update.comparison,
      },
    };
  });
}

/**
 * Redacts every text of an evidence value.
 *
 * The value of an evidence is a structure of facts. Every text in it is redacted, and
 * the structure itself is kept, so the evidence of a finding stays readable.
 */
export function redactEvidence(evidence: unknown): unknown {
  if (typeof evidence === 'string') return redactSecrets(evidence).text;
  if (Array.isArray(evidence)) return evidence.map((item) => redactEvidence(item));
  if (evidence === null || typeof evidence !== 'object') return evidence;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence as Record<string, unknown>)) {
    redacted[key] = redactEvidence(value);
  }
  return redacted;
}
