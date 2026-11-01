/**
 * The exposed-file check (ADR-0052 section 3, check 5).
 *
 * The check requests the fixed paths of the catalogue, the extra paths the
 * administrator configured and the source maps that sit next to the scripts
 * the scan actually discovered. Every target gets one size-capped GET; a HEAD
 * would prove nothing about the content.
 *
 * A status of 200 never confirms an exposure on its own: the body has to
 * match a signature of the catalogue. A generic page — the single page
 * application that answers every path — is not an exposed `.env` and not an
 * exposed git directory.
 *
 * The body is read into memory, matched and hashed, and then dropped. No
 * environment file, no git metadata, no server status page and no source map
 * ever reaches a finding: the evidence holds the status, the content
 * category, the length, the trusted signature and the digest.
 */

import { createHash } from 'node:crypto';

import { isScanTransportError } from '../errors.js';
import type { CheckEvaluation, CheckEvaluationContext } from '../evaluation.js';
import { canonicalHostname, evaluateExtraFilePath } from '../scope.js';
import { decodeSegments } from '../urls.js';
import type { OccurrenceFinding, PathRule } from '../types.js';
import {
  EXPOSED_FILE_KINDS,
  EXTRA_FILE_KIND,
  FILE_SIGNATURE_NAMES,
  SOURCE_MAP_KIND,
  type ContentCategory,
  type ExposedFileKind,
} from './catalogue.js';
import {
  attributeValue,
  buildFinding,
  contentCategory,
  coverageRow,
  decodeBody,
  htmlElements,
  safeLocationOf,
} from './shared.js';

/** The subject of a source map occurrence. */
const SOURCE_MAP_SUBJECT = 'source-map';

/** The subject of an extra path occurrence. */
const EXTRA_FILE_SUBJECT = 'extra-file';

/** A matcher of one catalogue signature. */
type SignatureMatcher = (body: string, category: ContentCategory) => boolean;

/** Whether a body is a source map. */
function isSourceMap(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const record = parsed as { version?: unknown; sources?: unknown };
    return record.version === 3 && Array.isArray(record.sources);
  } catch {
    return false;
  }
}

/**
 * The matchers of the catalogue signatures.
 *
 * Every matcher reads a bounded body. None of them keeps a part of the body.
 */
const SIGNATURE_MATCHERS: Readonly<Record<string, SignatureMatcher>> = {
  [FILE_SIGNATURE_NAMES.gitHeadRef]: (body) =>
    /^ref:\s+\S+$/m.test(body) || /^[0-9a-f]{40}$/m.test(body),
  [FILE_SIGNATURE_NAMES.gitHeadText]: (body, category) =>
    category === 'text' && /^\s*(?:ref:\s+refs\/\S+|[0-9a-f]{64})\s*$/i.test(body),
  [FILE_SIGNATURE_NAMES.envAssignments]: (body, category) =>
    category !== 'html' && /^[A-Z][A-Z0-9_]*=/m.test(body),
  [FILE_SIGNATURE_NAMES.envText]: (body, category) =>
    category === 'text' && /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(body),
  [FILE_SIGNATURE_NAMES.apacheServerStatus]: (body) => /server status|total accesses:/i.test(body),
  [FILE_SIGNATURE_NAMES.serverStatusText]: (body, category) =>
    category === 'text' && /\b(?:uptime|requests per second|busyworkers|idleworkers)\s*[:=]/i.test(body),
  [FILE_SIGNATURE_NAMES.adminInterface]: (body, category) =>
    category === 'html' && /type\s*=\s*["']?password/i.test(body),
  [FILE_SIGNATURE_NAMES.adminHtml]: (body, category) =>
    category === 'html' && /\badmin\b/i.test(body),
  [FILE_SIGNATURE_NAMES.robotsTxt]: (body) => /user-agent\s*:/i.test(body),
  [FILE_SIGNATURE_NAMES.robotsDirectives]: (body) =>
    /disallow\s*:|allow\s*:|sitemap\s*:/i.test(body),
  [FILE_SIGNATURE_NAMES.securityTxt]: (body) => /contact\s*:/i.test(body),
  [FILE_SIGNATURE_NAMES.securityTxtFields]: (body) =>
    /expires\s*:|preferred-languages\s*:|canonical\s*:|policy\s*:/i.test(body),
  [FILE_SIGNATURE_NAMES.sourceMap]: (body) => isSourceMap(body),
  [FILE_SIGNATURE_NAMES.sourceMapText]: (body, category) =>
    category === 'text' && /"version"\s*:\s*3\b/.test(body) && /"sources"\s*:/.test(body),
  [FILE_SIGNATURE_NAMES.fileContent]: (body, category) =>
    category !== 'html' && body.trim() !== '',
};

/** One file the check may request. */
interface FileTarget {
  readonly path: string;
  readonly kind: ExposedFileKind;
  readonly subject: string;
}

/** The last segment of a path. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.length === 0 ? '' : (parts[parts.length - 1] ?? '');
}

/**
 * Whether a redirect forwards to the file that was probed.
 *
 * Such a redirect proves nothing: the file may still be served. A redirect to
 * a different route — a login page — proves that the file is not served
 * there.
 */
function forwardsToSameResource(locationPath: string, probedPath: string): boolean {
  if (locationPath === probedPath) {
    return true;
  }
  const prefix = probedPath.endsWith('/') ? probedPath : `${probedPath}/`;
  if (locationPath.startsWith(prefix)) {
    return true;
  }
  return lastSegment(locationPath) === lastSegment(probedPath);
}

/** Whether a redirect proves that the probed file is not served there. */
function isDecisiveNegative(location: string | null, probedPath: string, baseUrl: string): boolean {
  if (location === null) {
    return false;
  }
  let target: URL;
  try {
    target = new URL(location, baseUrl);
    const destination = `/${decodeSegments(target.pathname).join('/')}`;
    const original = `/${decodeSegments(probedPath).join('/')}`;
    return !forwardsToSameResource(destination, original);
  } catch {
    return false;
  }
}

/** The script paths the received pages reference. */
function discoveredScriptPaths(context: CheckEvaluationContext): readonly string[] {
  const host = canonicalHostname(context.scope.hostname);
  const paths = new Set<string>();
  for (const target of context.targets) {
    if (!target.destinationReached) {
      continue;
    }
    for (const element of htmlElements(decodeBody(target.body))) {
      if (element.tagName !== 'script') {
        continue;
      }
      const source = attributeValue(element, 'src');
      if (source === null || source === '') {
        continue;
      }
      let url: URL;
      try {
        url = new URL(source, target.finalUrl);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || canonicalHostname(url.hostname) !== host) {
        continue;
      }
      if (url.search !== '' || url.hash !== '') {
        continue;
      }
      paths.add(url.pathname);
    }
  }
  return [...paths];
}

/**
 * The exposed-file check of one scan.
 *
 * The fixed paths of the catalogue and the extra paths of the site are
 * requested, and the source maps of the discovered scripts are requested after
 * they were bound by the request capability.
 */
export async function evaluateFiles(
  context: CheckEvaluationContext,
): Promise<readonly CheckEvaluation[]> {
  const results: CheckEvaluation[] = [];
  for (const target of context.targets) {
    // The exposed-file issues belong to the file targets, not to the pages.
    // The row records that the check ran for the page and evaluated no issue
    // of its own there.
    results.push(pageCoverage(target.targetKey));
  }
  const host = canonicalHostname(context.scope.hostname);
  const approved = approvedRoutes(context);
  for (const kind of EXPOSED_FILE_KINDS) {
    const target: FileTarget = { path: kind.path, kind, subject: kind.path };
    results.push(await evaluateFileTarget(context, { host, approved, target }));
  }
  for (const path of context.scope.extraFilePaths) {
    const target: FileTarget = { path, kind: EXTRA_FILE_KIND, subject: EXTRA_FILE_SUBJECT };
    results.push(await evaluateExtraTarget(context, { host, approved, target }));
  }
  const mapPaths = context.request.bindDiscoveredScripts(discoveredScriptPaths(context));
  for (const mapPath of mapPaths) {
    const target: FileTarget = { path: mapPath, kind: SOURCE_MAP_KIND, subject: SOURCE_MAP_SUBJECT };
    results.push(await evaluateFileTarget(context, { host, approved, target }));
  }
  return results;
}

/** The row of a page the file check evaluated no issue of. */
function pageCoverage(targetKey: string): CheckEvaluation {
  return {
    coverage: coverageRow({
      targetKey,
      checkId: 'files',
      evaluatedIssueIds: [],
      outcome: 'checked',
      reason: undefined,
    }),
    findings: [],
  };
}

/** The routes the file check may show literally. */
function approvedRoutes(context: CheckEvaluationContext): readonly PathRule[] {
  return [
    ...context.scope.crawlPaths,
    ...EXPOSED_FILE_KINDS.map((kind) => ({ path: kind.path, kind: 'exact' as const })),
    ...context.scope.extraFilePaths.map((path) => ({ path, kind: 'exact' as const })),
  ];
}

/** The input of one file request. */
interface FileRequest {
  readonly host: string;
  readonly approved: readonly PathRule[];
  readonly target: FileTarget;
}

/** Requests one extra path of the site, or records that it is not allowed. */
async function evaluateExtraTarget(
  context: CheckEvaluationContext,
  request: FileRequest,
): Promise<CheckEvaluation> {
  const { host, target } = request;
  if (evaluateExtraFilePath(context.scope, target.path).allowed) {
    return await evaluateFileTarget(context, request);
  }
  const skipped: CheckEvaluation = {
    coverage: coverageRow({
      targetKey: context.identity.identifyTarget(`https://${host}${target.path}`),
      checkId: 'files',
      evaluatedIssueIds: [],
      outcome: 'not-visited',
      reason: 'not_visited',
    }),
    findings: [],
  };
  context.emit([skipped]);
  return skipped;
}

/** Requests one file and evaluates the answer. */
async function evaluateFileTarget(
  context: CheckEvaluationContext,
  request: FileRequest,
): Promise<CheckEvaluation> {
  const { host, approved, target } = request;
  const url = `https://${host}${target.path}`;
  const targetKey = context.identity.identifyTarget(url);
  let response;
  try {
    response = await context.request.getFixedFile(target.path);
  } catch (error) {
    if (!isScanTransportError(error)) {
      throw error;
    }
    const failed: CheckEvaluation = {
      coverage: coverageRow({
        targetKey,
        checkId: 'files',
        evaluatedIssueIds: [],
        outcome: 'error',
        reason: 'target_error',
      }),
      findings: [],
    };
    context.emit([failed]);
    return failed;
  }
  const result = evaluateFileAnswer(context, { targetKey, url, approved, target, response });
  // The result of a file is published at once, so a later file that stops the
  // scan does not take it away.
  context.emit([result]);
  return result;
}

/** The input of the evaluation of one answer. */
interface FileAnswer {
  readonly targetKey: string;
  readonly url: string;
  readonly approved: readonly PathRule[];
  readonly target: FileTarget;
  readonly response: { readonly status: number; readonly headers: Headers; readonly body: Uint8Array };
}

/** Evaluates the answer of one file request. */
function evaluateFileAnswer(context: CheckEvaluationContext, answer: FileAnswer): CheckEvaluation {
  const { targetKey, url, approved, target, response } = answer;
  const status = response.status;
  if (status >= 200 && status < 300) {
    return {
      coverage: coverageRow({
        targetKey,
        checkId: 'files',
        evaluatedIssueIds: [target.kind.issueId],
        outcome: 'checked',
        reason: undefined,
      }),
      findings: contentFindings(context, { targetKey, url, approved, target, response }),
    };
  }
  if (status === 401 || status === 403 || status === 404 || status === 410) {
    return {
      coverage: coverageRow({
        targetKey,
        checkId: 'files',
        evaluatedIssueIds: [target.kind.issueId],
        outcome: 'checked',
        reason: undefined,
      }),
      findings: [],
    };
  }
  if (status >= 300 && status < 400) {
    const decisive = isDecisiveNegative(response.headers.get('location'), target.path, url);
    return {
      coverage: coverageRow({
        targetKey,
        checkId: 'files',
        evaluatedIssueIds: decisive ? [target.kind.issueId] : [],
        outcome: decisive ? 'checked' : 'not-visited',
        reason: decisive ? undefined : 'redirect_out_of_scope',
      }),
      findings: [],
    };
  }
  return {
    coverage: coverageRow({
      targetKey,
      checkId: 'files',
      evaluatedIssueIds: [],
      outcome: 'not-visited',
      reason: 'target_error',
    }),
    findings: [],
  };
}

/** The input of the findings of a file that answered with content. */
interface FileContent {
  readonly targetKey: string;
  readonly url: string;
  readonly approved: readonly PathRule[];
  readonly target: FileTarget;
  readonly response: { readonly status: number; readonly headers: Headers; readonly body: Uint8Array };
}

/** The findings of a file that answered with content. */
function contentFindings(
  context: CheckEvaluationContext,
  content: FileContent,
): readonly OccurrenceFinding[] {
  const { targetKey, url, approved, target, response } = content;
  const body = decodeBody(response.body);
  const category = contentCategory(response.headers.get('content-type'), body);
  const signature = matchSignature(target.kind, body, category);
  if (signature === null) {
    return [];
  }
  const digest = createHash('sha256').update(response.body).digest('hex');
  const validation = signature.strong ? 'Confirmed' : 'Likely';
  return [
    buildFinding({
      context,
      targetKey,
      checkId: 'files',
      issueId: target.kind.issueId,
      subject: target.subject,
      safeLocation: safeLocationOf(context, url, approved),
      validation,
      confidence: validation === 'Confirmed' ? 'high' : 'medium',
      evidence: {
        status: response.status,
        content_type: category,
        length: response.body.length,
        signature: signature.name,
        digest,
      },
    }),
  ];
}

/** The signature a body matched, or null. */
function matchSignature(
  kind: ExposedFileKind,
  body: string,
  category: ContentCategory,
): { readonly name: string; readonly strong: boolean } | null {
  const strong = SIGNATURE_MATCHERS[kind.strongSignature];
  if (strong !== undefined && strong(body, category)) {
    return { name: kind.strongSignature, strong: true };
  }
  const weakName = kind.weakSignature;
  if (weakName === null) {
    return null;
  }
  const weak = SIGNATURE_MATCHERS[weakName];
  if (weak !== undefined && weak(body, category)) {
    return { name: weakName, strong: false };
  }
  return null;
}
