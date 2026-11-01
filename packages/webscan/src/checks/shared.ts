/**
 * Shared helpers of the catalogue checks (ADR-0052 section 3).
 *
 * Everything here is structural: it builds findings from catalogue facts, it
 * classifies response bodies into a closed set of categories and it reads the
 * received pages. No helper ever copies a raw header value, a raw body or a
 * raw URL into a finding.
 */

import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import { computeEvidenceHash, type EvidenceFacts } from '../evidence.js';
import type { CheckEvaluationContext } from '../evaluation.js';
import { computeIssueKey, safeDisplayUrl } from '../identity.js';
import type {
  CheckId,
  Confidence,
  CoverageEntry,
  CoverageSubjectScope,
  OccurrenceFinding,
  PathRule,
  Validation,
} from '../types.js';
import { CHECK_VERSIONS, catalogueIssue, type ContentCategory } from './catalogue.js';

const decoder = new TextDecoder('utf-8', { fatal: false });

/** Decodes a bounded body as UTF-8 text. */
export function decodeBody(body: Uint8Array): string {
  return decoder.decode(body);
}

/** Whether a node is an element. A tag name never starts with a hash. */
function isElementNode(node: DefaultTreeAdapterTypes.ChildNode): node is DefaultTreeAdapterTypes.Element {
  return !node.nodeName.startsWith('#');
}

/** Collects every element of a parsed document. */
function collectElements(
  node: DefaultTreeAdapterTypes.ParentNode,
  elements: DefaultTreeAdapterTypes.Element[],
): void {
  for (const child of node.childNodes) {
    if (!isElementNode(child)) {
      continue;
    }
    elements.push(child);
    collectElements(child, elements);
  }
}

/**
 * Parses an HTML body and returns its elements.
 *
 * The parser is parse5: a real HTML parser, never a regular expression. No
 * script and no form of the page is ever executed.
 */
export function htmlElements(html: string): readonly DefaultTreeAdapterTypes.Element[] {
  const document = parse(html);
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  collectElements(document, elements);
  return elements;
}

/** The attribute value of an element, or null. */
export function attributeValue(
  element: DefaultTreeAdapterTypes.Element,
  name: string,
): string | null {
  for (const attribute of element.attrs) {
    if (attribute.name === name) {
      return attribute.value;
    }
  }
  return null;
}

/** The validation states ordered by strength. */
const VALIDATION_STRENGTH: readonly Validation[] = [
  'Informational',
  'Indicator',
  'Likely',
  'Confirmed',
];

/** Keeps a validation at or below the ceiling of the issue. */
export function clampValidation(validation: Validation, ceiling: Validation): Validation {
  return VALIDATION_STRENGTH.indexOf(validation) <= VALIDATION_STRENGTH.indexOf(ceiling)
    ? validation
    : ceiling;
}

/** The input of one finding. */
export interface FindingInput {
  readonly context: CheckEvaluationContext;
  readonly targetKey: string;
  readonly checkId: CheckId;
  readonly issueId: string;
  /** The stable subject of the occurrence. */
  readonly subject: string;
  /** The safe display of the location of the occurrence. */
  readonly safeLocation: string;
  readonly validation: Validation;
  readonly confidence: Confidence;
  /** Only catalogue-approved facts. */
  readonly evidence: EvidenceFacts;
}

/**
 * Builds one finding.
 *
 * The severity and the validation ceiling come from the catalogue, never from
 * the observation, and the evidence hash covers exactly the facts of the
 * finding.
 */
export function buildFinding(input: FindingInput): OccurrenceFinding {
  const issue = catalogueIssue(input.checkId, input.issueId);
  return {
    occurrenceKey: input.context.identity.identifyOccurrence({
      targetKey: input.targetKey,
      checkId: input.checkId,
      issueId: input.issueId,
      subject: input.subject,
    }),
    targetKey: input.targetKey,
    checkId: input.checkId,
    checkVersion: CHECK_VERSIONS[input.checkId],
    issueKey: computeIssueKey({
      checkId: input.checkId,
      issueId: input.issueId,
      hostname: input.context.scope.hostname,
    }),
    issueId: input.issueId,
    subject: input.subject,
    severity: issue.severity,
    validation: clampValidation(input.validation, issue.validationCeiling),
    confidence: input.confidence,
    safeLocation: input.safeLocation,
    evidenceHash: computeEvidenceHash({
      checkId: input.checkId,
      issueId: input.issueId,
      subject: input.subject,
      facts: input.evidence,
    }),
    evidence: input.evidence,
  };
}

/** The input of one coverage row. */
export interface CoverageInput {
  readonly targetKey: string;
  readonly checkId: CheckId;
  readonly evaluatedIssueIds: readonly string[];
  readonly outcome: CoverageEntry['outcome'];
  /** The reason, when the outcome is not a checked one. */
  readonly reason: CoverageEntry['reason'] | undefined;
  /**
   * The subjects the evaluated issue ids cover.
   *
   * A check whose issues belong to the whole target does not pass a scope: the
   * default is the complete target, so the coverage of such a check stays what
   * it was. A check that evaluates one subject only, such as the active check
   * on one parameter, passes a restricted scope.
   */
  readonly subjectScope?: CoverageSubjectScope;
}

/** Builds one coverage row. */
export function coverageRow(input: CoverageInput): CoverageEntry {
  const base = {
    targetKey: input.targetKey,
    checkId: input.checkId,
    checkVersion: CHECK_VERSIONS[input.checkId],
    evaluatedIssueIds: [...input.evaluatedIssueIds],
    outcome: input.outcome,
    subjectScope: input.subjectScope ?? { kind: 'complete' },
  };
  return input.reason === undefined ? base : { ...base, reason: input.reason };
}

/**
 * The safe display of a location.
 *
 * The routes of the site are approved for display. Every other path segment is
 * replaced by a placeholder, and every query value is replaced by a fixed
 * placeholder, so a dynamic path or a secret in a query never reaches a
 * result.
 */
export function safeLocationOf(
  context: CheckEvaluationContext,
  url: string,
  extraRoutes: readonly PathRule[] = [],
): string {
  return safeDisplayUrl(url, { approvedRoutes: [...context.scope.crawlPaths, ...extraRoutes] });
}

/**
 * Classifies a bounded body into a closed category.
 *
 * The category is the only part of the content type that may be persisted. The
 * raw header value never is.
 */
export function contentCategory(contentType: string | null, body: string): ContentCategory {
  const type = (contentType ?? '').toLowerCase();
  const head = body.slice(0, 512).trimStart().toLowerCase();
  if (type.includes('text/html') || head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return 'html';
  }
  if (type.includes('json') || head.startsWith('{') || head.startsWith('[')) {
    return 'json';
  }
  if (type.includes('javascript') || type.includes('ecmascript')) {
    return 'script';
  }
  if (type.startsWith('text/')) {
    return 'text';
  }
  if (type === '') {
    return body.trim() === '' ? 'unknown' : 'text';
  }
  return 'binary';
}
