/**
 * The header check (ADR-0052 section 3, check 1).
 *
 * The check reports the structural presence and validity of the security
 * headers of every page the scan received. It never copies a header value
 * into a finding: the evidence holds the header name and a boolean or a
 * number, nothing else.
 *
 * The headers of an authorized 3xx are evaluated as they arrived, even when
 * the destination was denied. A header that was received is a header that was
 * evaluated.
 */

import type { CheckEvaluation, CheckEvaluationContext, CheckTarget } from '../evaluation.js';
import type { OccurrenceFinding } from '../types.js';
import {
  FRAME_POLICY,
  HEADER_POLICIES,
  KNOWN_CSP_DIRECTIVES,
  KNOWN_REFERRER_POLICIES,
} from './catalogue.js';
import { buildFinding, coverageRow, safeLocationOf } from './shared.js';

/** Every issue the header check evaluates for a received page. */
const HEADER_ISSUE_IDS: readonly string[] = [
  ...HEADER_POLICIES.flatMap((policy) => [policy.missingIssueId, policy.invalidIssueId]),
  FRAME_POLICY.missingIssueId,
  FRAME_POLICY.invalidIssueId,
];

/** The structural facts of one content security policy. */
interface CspFacts {
  /** The directive names of the policy, lowercased. */
  readonly names: readonly string[];
  /** How many of them are known directives. */
  readonly known: number;
}

/** Reads the directive names of a content security policy. */
function cspFacts(value: string): CspFacts {
  const names: string[] = [];
  let known = 0;
  for (const part of value.split(';')) {
    const directive = part.trim();
    if (directive === '') {
      continue;
    }
    const name = (directive.split(/\s+/)[0] ?? '').toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) {
      continue;
    }
    names.push(name);
    if (KNOWN_CSP_DIRECTIVES.has(name)) {
      known += 1;
    }
  }
  return { names, known };
}

/** Whether a strict transport security policy is usable. */
function isValidStrictTransportSecurity(value: string): boolean {
  for (const part of value.split(';')) {
    const match = /^max-age\s*=\s*(\d+)$/i.exec(part.trim());
    if (match !== null) {
      return Number(match[1]) > 0;
    }
  }
  return false;
}

/** Whether a frame options value is usable. */
function isValidFrameOptions(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === 'DENY' || normalized === 'SAMEORIGIN';
}

/** Whether a content type options value is usable. */
function isValidContentTypeOptions(value: string): boolean {
  return value.trim().toLowerCase() === 'nosniff';
}

/** Whether a referrer policy value is known. */
function isValidReferrerPolicy(value: string): boolean {
  return KNOWN_REFERRER_POLICIES.has(value.trim().toLowerCase());
}

/** The items of a permissions policy. */
function permissionsItems(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Whether a permissions policy is parsable. */
function isValidPermissionsPolicy(value: string): boolean {
  const items = permissionsItems(value);
  if (items.length === 0) {
    return false;
  }
  return items.every((item) => /^[A-Za-z0-9-]+(\s*=\s*\([^)]*\))?$/.test(item));
}

/**
 * The header check of one scan.
 *
 * Every header issue is evaluated for every page the scan received: a header
 * that is present and valid proves that the missing and the invalid variant of
 * that policy do not hold any more.
 */
export async function evaluateHeaders(
  context: CheckEvaluationContext,
): Promise<readonly CheckEvaluation[]> {
  const results: CheckEvaluation[] = [];
  for (const target of context.targets) {
    const safeLocation = safeLocationOf(context, target.baselineUrl);
    const findings = [
      ...evaluateHeaderPolicies(context, target, safeLocation),
      ...evaluateFrameProtection(context, target, safeLocation),
    ];
    const result: CheckEvaluation = {
      coverage: coverageRow({
        targetKey: target.targetKey,
        checkId: 'headers',
        evaluatedIssueIds: HEADER_ISSUE_IDS,
        outcome: 'checked',
        reason: undefined,
      }),
      findings,
    };
    results.push(result);
    context.emit([result]);
  }
  return results;
}

/** The findings of the single-header policies of one target. */
function evaluateHeaderPolicies(
  context: CheckEvaluationContext,
  target: CheckTarget,
  safeLocation: string,
): readonly OccurrenceFinding[] {
  const findings: OccurrenceFinding[] = [];
  for (const policy of HEADER_POLICIES) {
    const value = target.headers.get(policy.header);
    if (value === null) {
      findings.push(
        buildFinding({
          context,
          targetKey: target.targetKey,
          checkId: 'headers',
          issueId: policy.missingIssueId,
          subject: policy.subject,
          safeLocation,
          validation: 'Confirmed',
          confidence: 'high',
          evidence: { header: policy.header },
        }),
      );
      continue;
    }
    if (isValidPolicy(policy.subject, value)) {
      continue;
    }
    findings.push(
      buildFinding({
        context,
        targetKey: target.targetKey,
        checkId: 'headers',
        issueId: policy.invalidIssueId,
        subject: policy.subject,
        safeLocation,
        validation: 'Confirmed',
        confidence: 'high',
        evidence: invalidEvidence(policy.subject, policy.header, value),
      }),
    );
  }
  return findings;
}

/** Whether the policy of a subject is usable. */
function isValidPolicy(subject: string, value: string): boolean {
  switch (subject) {
    case 'strict-transport-security':
      return isValidStrictTransportSecurity(value);
    case 'content-security-policy':
      return cspFacts(value).known > 0;
    case 'content-type-options':
      return isValidContentTypeOptions(value);
    case 'referrer-policy':
      return isValidReferrerPolicy(value);
    case 'permissions-policy':
      return isValidPermissionsPolicy(value);
    default:
      return true;
  }
}

/** The structural evidence of an invalid policy. */
function invalidEvidence(
  subject: string,
  header: string,
  value: string,
): Readonly<Record<string, string | number | boolean>> {
  switch (subject) {
    case 'content-security-policy':
      return { header, known_directives: cspFacts(value).known };
    case 'permissions-policy':
      return { header, directive_count: permissionsItems(value).length };
    case 'referrer-policy':
      return { header, known_value: false };
    case 'content-type-options':
      return { header, nosniff: false };
    default:
      return { header, has_max_age: false };
  }
}

/** The frame protection findings of one target. */
function evaluateFrameProtection(
  context: CheckEvaluationContext,
  target: CheckTarget,
  safeLocation: string,
): readonly OccurrenceFinding[] {
  const frameOptions = target.headers.get(FRAME_POLICY.header);
  const csp = target.headers.get('content-security-policy');
  const frameAncestors = csp !== null && cspFacts(csp).names.includes('frame-ancestors');
  const build = (issueId: string, evidence: Record<string, string | number | boolean>) =>
    buildFinding({
      context,
      targetKey: target.targetKey,
      checkId: 'headers',
      issueId,
      subject: FRAME_POLICY.subject,
      safeLocation,
      validation: 'Confirmed',
      confidence: 'high',
      evidence,
    });
  if (frameOptions === null && !frameAncestors) {
    return [
      build(FRAME_POLICY.missingIssueId, {
        x_frame_options: false,
        csp_frame_ancestors: false,
      }),
    ];
  }
  if (frameOptions !== null && !isValidFrameOptions(frameOptions) && !frameAncestors) {
    return [
      build(FRAME_POLICY.invalidIssueId, {
        x_frame_options: true,
        csp_frame_ancestors: false,
      }),
    ];
  }
  return [];
}
