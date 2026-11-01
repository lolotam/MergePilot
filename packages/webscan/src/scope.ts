/**
 * Scope policy for the website scanner (ADR-0052 sections 2 and 5).
 *
 * The scope answers one question: may this scan request this URL? Every
 * decision is taken against the site that owns the scan, never against the
 * global site list, so a redirect to another listed site is denied as well.
 *
 * The module is pure. It parses and canonicalizes URLs but never performs a
 * request and never resolves a name.
 */

import type { ScanPolicyCode } from './errors.js';
import type { ParameterRule, PathRule, ScanScope } from './types.js';
import {
  ScanUrlError,
  canonicalHostname,
  compareCodeUnits,
  decodeSegments,
  normalizeRulePath,
  parseCanonicalUrl,
  type CanonicalUrl,
} from './urls.js';

export {
  ScanUrlError,
  canonicalHostname,
  normalizeRulePath,
  parseCanonicalUrl,
  type CanonicalUrl,
  type QueryPair,
  type ScanUrlErrorCode,
} from './urls.js';

/**
 * Why a candidate was denied by the scope.
 *
 * The reasons are the policy codes of the control contract, without the one
 * that only the transport can decide: whether an address may be reached.
 */
export type ScopeDenialReason = Exclude<ScanPolicyCode, 'address_not_allowed'>;

/** The outcome of a scope evaluation. */
export interface ScopeDecision {
  readonly allowed: boolean;
  readonly reason?: ScopeDenialReason;
}

/**
 * Path segments and query parameter names that are never requested.
 *
 * ADR-0052 section 2: the crawler skips decoded path segments and query
 * parameter names containing these terms, case-insensitively.
 */
export const ACTION_DENYLIST: readonly string[] = Object.freeze([
  'logout',
  'signout',
  'delete',
  'remove',
  'reset',
  'unsubscribe',
  'action',
]);

const ALLOWED_DECISION: ScopeDecision = Object.freeze({ allowed: true });

function deny(reason: ScopeDenialReason): ScopeDecision {
  return { allowed: false, reason };
}

/** The decoded segments of a rule path, or null when the rule is malformed. */
function ruleSegments(path: string): string[] | null {
  try {
    return decodeSegments(normalizeRulePath(path));
  } catch {
    return null;
  }
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/**
 * Whether a path rule matches the given decoded path segments.
 *
 * A prefix rule ends at a segment boundary: `/docs` matches `/docs` and
 * `/docs/a`, never `/docs-admin`. A malformed rule matches nothing.
 */
export function matchesPathRule(rule: PathRule, candidateSegments: readonly string[]): boolean {
  const parts = ruleSegments(rule.path);
  if (parts === null) {
    return false;
  }
  if (rule.kind === 'exact') {
    return sameSegments(parts, candidateSegments);
  }
  if (rule.kind !== 'prefix') {
    return false;
  }
  return (
    candidateSegments.length >= parts.length && parts.every((part, index) => part === candidateSegments[index])
  );
}

/** Whether any of the rules matches the given decoded path segments. */
export function matchesAnyPathRule(
  rules: readonly PathRule[],
  candidateSegments: readonly string[],
): boolean {
  return rules.some((rule) => matchesPathRule(rule, candidateSegments));
}

/** Whether a decoded path segment or query parameter name is a denied action. */
export function isActionDenied(segment: string): boolean {
  const lowered = segment.toLowerCase();
  return ACTION_DENYLIST.some((term) => lowered.includes(term));
}

/**
 * The parameter names authorized on an exact path, or null when the path has
 * no authorization at all.
 */
function authorizedParameterNames(
  rules: readonly ParameterRule[],
  candidateSegments: readonly string[],
): Set<string> | null {
  const names = new Set<string>();
  let matched = false;
  for (const rule of rules) {
    const parts = ruleSegments(rule.path);
    if (parts === null || !sameSegments(parts, candidateSegments)) {
      continue;
    }
    matched = true;
    for (const name of rule.parameters) {
      names.add(name);
    }
  }
  return matched ? names : null;
}

/**
 * Whether a parameterized link is authorized.
 *
 * The link needs an exact-path authorization that names every parameter the
 * link carries. Query values are never part of the authorization, so a value
 * change never needs a new authorization.
 */
export function isParameterizedLinkAuthorized(scope: ScanScope, url: CanonicalUrl): boolean {
  const names = authorizedParameterNames(scope.parameterizedPaths, url.segments);
  if (names === null) {
    return false;
  }
  return url.queryNames.every((name) => names.has(name));
}

/**
 * Whether an active probe is authorized on this link.
 *
 * This is the additional opt-in of ADR-0052 section 2. Reaching an active
 * probe still requires the parameterized crawl authorization of the link.
 */
export function isActiveProbeAuthorized(scope: ScanScope, url: CanonicalUrl): boolean {
  const names = authorizedParameterNames(scope.activePaths, url.segments);
  if (names === null) {
    return false;
  }
  return url.queryNames.every((name) => names.has(name));
}

/**
 * The parameter names an active probe may use on this link.
 *
 * The names are the ones the administrator authorized for the path and the
 * link actually carries. They are sorted by their code units, so the order of
 * the query never decides which parameter a check probes: `?a=1&b=2` and
 * `?b=2&a=1` name the same subject. The comparison is case sensitive, so `Q`
 * and `q` stay two different subjects.
 *
 * The names are names only: a query value never reaches this list.
 */
export function activeProbeParameterNames(scope: ScanScope, url: CanonicalUrl): readonly string[] {
  const authorized = authorizedParameterNames(scope.activePaths, url.segments);
  if (authorized === null) {
    return [];
  }
  const names = new Set<string>();
  for (const name of url.queryNames) {
    if (authorized.has(name)) {
      names.add(name);
    }
  }
  return [...names].sort(compareCodeUnits);
}

function parseCandidate(candidate: string): { ok: true; url: CanonicalUrl } | { ok: false; reason: ScopeDenialReason } {
  try {
    return { ok: true, url: parseCanonicalUrl(candidate) };
  } catch (error) {
    if (error instanceof ScanUrlError) {
      return { ok: false, reason: error.code };
    }
    return { ok: false, reason: 'invalid_url' };
  }
}

function checkHost(scope: ScanScope, url: CanonicalUrl): ScopeDecision {
  if (url.hostname !== canonicalHostname(scope.hostname)) {
    return deny('host_not_allowed');
  }
  return ALLOWED_DECISION;
}

function checkBlockedPaths(scope: ScanScope, url: CanonicalUrl): ScopeDecision {
  if (matchesAnyPathRule(scope.blockedPaths, url.segments)) {
    return deny('blocked_path');
  }
  return ALLOWED_DECISION;
}

function checkActionDenylist(url: CanonicalUrl): ScopeDecision {
  for (const segment of url.segments) {
    if (isActionDenied(segment)) {
      return deny('action_denied');
    }
  }
  for (const name of url.queryNames) {
    if (isActionDenied(name)) {
      return deny('action_denied');
    }
  }
  return ALLOWED_DECISION;
}

/**
 * Whether a discovered link may be crawled.
 *
 * The link must be on the site itself, over HTTPS, outside the blocked paths
 * and outside the action denylist, inside the administrator's crawl rules, and
 * — when it carries query parameters — separately authorized as a
 * parameterized link.
 */
export function evaluateCrawlTarget(scope: ScanScope, candidate: string): ScopeDecision {
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) {
    return deny(parsed.reason);
  }
  const url = parsed.url;
  const host = checkHost(scope, url);
  if (!host.allowed) {
    return host;
  }
  if (url.protocol !== 'https:') {
    return deny('scheme_not_allowed');
  }
  const blocked = checkBlockedPaths(scope, url);
  if (!blocked.allowed) {
    return blocked;
  }
  const action = checkActionDenylist(url);
  if (!action.allowed) {
    return action;
  }
  if (!matchesAnyPathRule(scope.crawlPaths, url.segments)) {
    return deny('path_not_allowed');
  }
  if (url.queryPairs.length > 0 && !isParameterizedLinkAuthorized(scope, url)) {
    return deny('parameter_not_allowed');
  }
  return ALLOWED_DECISION;
}

/**
 * Whether an explicit scan target may be requested.
 *
 * The base page and the fixed paths of enabled checks are explicit targets,
 * not permission to crawl every link, so they do not need a crawl rule. They
 * are still bound by the host, scheme, blocked path and action denylist rules,
 * and they are always query-free.
 */
export function evaluateExplicitTarget(scope: ScanScope, candidate: string): ScopeDecision {
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) {
    return deny(parsed.reason);
  }
  const url = parsed.url;
  const host = checkHost(scope, url);
  if (!host.allowed) {
    return host;
  }
  if (url.protocol !== 'https:') {
    return deny('scheme_not_allowed');
  }
  const blocked = checkBlockedPaths(scope, url);
  if (!blocked.allowed) {
    return blocked;
  }
  const action = checkActionDenylist(url);
  if (!action.allowed) {
    return action;
  }
  if (url.queryPairs.length > 0) {
    return deny('query_not_allowed');
  }
  return ALLOWED_DECISION;
}

/**
 * Whether the baseline of a parameterized link may be requested.
 *
 * A parameterized link has its own authorization: the administrator named the
 * exact path and every parameter name the link may carry. The crawl rules do
 * not replace it, and a link whose parameter names are not named is refused.
 */
export function evaluateParameterizedTarget(scope: ScanScope, candidate: string): ScopeDecision {
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) {
    return deny(parsed.reason);
  }
  const url = parsed.url;
  const host = checkHost(scope, url);
  if (!host.allowed) {
    return host;
  }
  if (url.protocol !== 'https:') {
    return deny('scheme_not_allowed');
  }
  const blocked = checkBlockedPaths(scope, url);
  if (!blocked.allowed) {
    return blocked;
  }
  const action = checkActionDenylist(url);
  if (!action.allowed) {
    return action;
  }
  if (!isParameterizedLinkAuthorized(scope, url)) {
    return deny('parameter_not_allowed');
  }
  return ALLOWED_DECISION;
}

/**
 * Whether an active probe may be sent to a parameterized link.
 *
 * The active probe is the additional opt-in of ADR-0052 section 2: the link
 * needs the parameterized authorization *and* the active authorization of its
 * path and parameter names.
 */
export function evaluateActiveProbeTarget(scope: ScanScope, candidate: string): ScopeDecision {
  const baseline = evaluateParameterizedTarget(scope, candidate);
  if (!baseline.allowed) {
    return baseline;
  }
  const url = parseCanonicalUrl(candidate);
  if (!isActiveProbeAuthorized(scope, url)) {
    return deny('parameter_not_allowed');
  }
  return ALLOWED_DECISION;
}

/**
 * Whether the port-80 transport probe may be sent.
 *
 * ADR-0052 section 2 allows exactly one cleartext request: to the fixed path
 * `/` of the same host, without a query, and only when that path is not
 * blocked. It never carries the base path, because a base path may hold a
 * secret.
 */
export function evaluateTransportProbe(scope: ScanScope, candidate: string): ScopeDecision {
  const parsed = parseCandidate(candidate);
  if (!parsed.ok) {
    return deny(parsed.reason);
  }
  const url = parsed.url;
  const host = checkHost(scope, url);
  if (!host.allowed) {
    return host;
  }
  if (url.protocol !== 'http:') {
    return deny('scheme_not_allowed');
  }
  // The fixed path is the root itself, written literally. A path that only
  // resolves to the root after the server decodes it is not the fixed path.
  if (url.path !== '/') {
    return deny('path_not_allowed');
  }
  if (url.queryPairs.length > 0) {
    return deny('query_not_allowed');
  }
  const blocked = checkBlockedPaths(scope, url);
  if (!blocked.allowed) {
    return blocked;
  }
  return ALLOWED_DECISION;
}

/**
 * Whether a path contains a traversal segment.
 *
 * A traversal segment is rejected instead of being resolved, so an extra path
 * always means exactly the path the administrator typed.
 */
function hasTraversalSegment(path: string): boolean {
  const body = path.startsWith('/') ? path.slice(1) : path;
  if (body === '') {
    return false;
  }
  return body.split('/').some((segment) => {
    try {
      return decodeURIComponent(segment).split('/').includes('..');
    } catch {
      return false;
    }
  });
}

/**
 * Whether an administrator-supplied extra exposed-file path may be requested.
 *
 * Extra paths are same-host relative paths. They cannot supply another origin
 * and they never override a blocked path.
 */
export function evaluateExtraFilePath(scope: ScanScope, path: string): ScopeDecision {
  if (!path.startsWith('/')) {
    return deny('not_relative_path');
  }
  if (path.includes('?') || path.includes('#')) {
    return deny('query_not_allowed');
  }
  // A backslash is a path separator for HTTP schemes, so it can turn a
  // same-host path into another origin. It is never a literal in a path the
  // administrator typed, so it is rejected instead of being normalized.
  if (path.includes('\\')) {
    return deny('not_relative_path');
  }
  if (hasTraversalSegment(path)) {
    return deny('path_not_allowed');
  }
  const parsed = parseCandidate(new URL(path, `https://${canonicalHostname(scope.hostname)}/`).href);
  if (!parsed.ok) {
    return deny(parsed.reason);
  }
  const url = parsed.url;
  // The resolved URL is checked against the site again: a protocol-relative
  // path resolves to another origin, and an extra path may never supply one.
  const host = checkHost(scope, url);
  if (!host.allowed) {
    return host;
  }
  if (url.protocol !== 'https:') {
    return deny('scheme_not_allowed');
  }
  const blocked = checkBlockedPaths(scope, url);
  if (!blocked.allowed) {
    return blocked;
  }
  return checkActionDenylist(url);
}
