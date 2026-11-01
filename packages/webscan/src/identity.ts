/**
 * Identity and safe display for scan targets (ADR-0052 section 4).
 *
 * Two different things are kept apart on purpose:
 *
 * - The **request identity** is derived from the original baseline URL of a
 *   target. It is a keyed digest, so the raw URL and the raw query values
 *   never persist. A mutated probe, such as the SQL or reflection marker,
 *   never contributes to an identity.
 * - The **safe display** is what a human reads. It carries the host, the
 *   approved route or redacted path placeholders, and the query parameter
 *   names, but never a userinfo, a fragment or a query value.
 *
 * The package never creates a key. The app owns the per-site identity key and
 * its key management, and injects the resulting functions.
 */

import { createHmac } from 'node:crypto';

import {
  canonicalHostname,
  matchesPathRule,
  normalizeRulePath,
  parseCanonicalUrl,
  type CanonicalUrl,
} from './scope.js';
import { compareCodeUnits } from './urls.js';
import type { CheckId, PathRule } from './types.js';

/** Per-site identity key material. Supplied by the app, never generated here. */
export type IdentityKey = Uint8Array;

/** The minimum size of an identity key, so a blank key cannot be used. */
const MINIMUM_KEY_BYTES = 16;

/** The inputs of one occurrence identity. */
export interface OccurrenceIdentityInput {
  /** Identity of the baseline target the occurrence was found on. */
  readonly targetKey: string;
  readonly checkId: CheckId;
  /** Immutable catalogue issue id. */
  readonly issueId: string;
  /** Stable check subject, for example a cookie name. */
  readonly subject: string;
}

/** The inputs of one issue identity. */
export interface IssueIdentityInput {
  readonly checkId: CheckId;
  readonly issueId: string;
  readonly hostname: string;
}

/** The identity functions the scan dependencies carry. */
export interface SiteIdentity {
  readonly identifyTarget: (baselineUrl: string) => string;
  readonly identifyOccurrence: (input: OccurrenceIdentityInput) => string;
}

/** An identity key that is too weak to use. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * Encodes fields into one unambiguous string.
 *
 * Every field carries its length, so no two different field lists can produce
 * the same encoded tuple.
 */
function encodeFields(fields: readonly string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join('');
}

/**
 * The canonical query fields of a target.
 *
 * Parameter names are sorted, and the order of repeated values inside one name
 * is kept. The values themselves are part of the tuple, so a changed value is
 * a different target, but they never leave this function.
 */
function canonicalQueryFields(url: CanonicalUrl): string[] {
  const names = [...new Set(url.queryPairs.map((pair) => pair.name))].sort(compareCodeUnits);
  const fields: string[] = [];
  for (const name of names) {
    const values = url.queryPairs.filter((pair) => pair.name === name).map((pair) => pair.value);
    // Preserve each name/value group's boundary: another parameter's name
    // must never be interpreted as one more repeated value of this name.
    fields.push(encodeFields([name, ...values]));
  }
  return fields;
}

function hmac(key: IdentityKey, payload: string): string {
  if (!(key instanceof Uint8Array) || key.byteLength < MINIMUM_KEY_BYTES) {
    throw new IdentityError(
      `The identity key must be at least ${MINIMUM_KEY_BYTES} bytes of per-site key material.`,
    );
  }
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

/**
 * The canonical description of one target.
 *
 * The description covers the canonical host, the normalized path and the
 * canonical query name/value pairs: the parameter names are sorted and the
 * order of repeated values inside one name is kept. Two links that differ only
 * in the order of their query names share one description, so they are one
 * target.
 *
 * The description is the tuple the identity digest covers. It stays inside the
 * package: the raw query values never leave `canonicalQueryFields`.
 */
export function canonicalTargetDescription(url: CanonicalUrl): string {
  return encodeFields([url.hostname, url.path, ...canonicalQueryFields(url)]);
}

/**
 * The identity of one baseline target.
 *
 * The digest covers the canonical host, the normalized path and the canonical
 * query name/value pairs. Only the digest is meant to be persisted.
 */
export function computeTargetKey(baselineUrl: string, key: IdentityKey): string {
  return hmac(key, canonicalTargetDescription(parseCanonicalUrl(baselineUrl)));
}

/**
 * The identity of one occurrence of a check issue on a target.
 *
 * The digest covers the target identity, the check id, the immutable issue id
 * and the stable subject, so two cookies, two query variants and two checks
 * never share an identity.
 */
export function computeOccurrenceKey(input: OccurrenceIdentityInput, key: IdentityKey): string {
  const tuple = encodeFields([input.targetKey, input.checkId, input.issueId, input.subject]);
  return hmac(key, tuple);
}

/**
 * The group identity of an issue on a site.
 *
 * The issue key is check id, issue id and canonical host. It is the group
 * identity for reports and alert aggregation, independent of crawl order.
 */
export function computeIssueKey(input: IssueIdentityInput): string {
  return `${input.checkId}|${input.issueId}|${canonicalHostname(input.hostname)}`;
}

/**
 * Builds the identity functions of one site from its own key.
 *
 * The app supplies the key; this factory only binds it to the two functions
 * the scan dependencies carry. It never creates a key and never shares one
 * between sites.
 */
export function createSiteIdentity(key: IdentityKey): SiteIdentity {
  return {
    identifyTarget: (baselineUrl: string) => computeTargetKey(baselineUrl, key),
    identifyOccurrence: (input: OccurrenceIdentityInput) => computeOccurrenceKey(input, key),
  };
}

/** How a URL is rendered in a finding, an export or a dashboard. */
export interface SafeDisplayOptions {
  /**
   * Administrator-approved route patterns. A path that matches one is shown
   * literally, because the administrator already decided that path is safe to
   * display. The site's crawl rules are the natural source of these.
   */
  readonly approvedRoutes?: readonly PathRule[];
  /** The placeholder used for a dynamic path segment. */
  readonly placeholder?: string;
}

const QUERY_VALUE_PLACEHOLDER = 'REDACTED';
const DEFAULT_PATH_PLACEHOLDER = '{segment}';
const UNUSABLE_DISPLAY = '(invalid-url)';

function parseForDisplay(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function displaySegments(pathname: string): string[] {
  const body = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (body === '') {
    return [];
  }
  return body.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function displayPath(
  segments: readonly string[],
  approvedRoutes: readonly PathRule[],
  placeholder: string,
): string {
  if (segments.length === 0) {
    return '/';
  }
  const approved = approvedRoutes.find((rule) => matchesPathRule(rule, segments));
  if (approved !== undefined) {
    return normalizeRulePath(approved.path);
  }
  return `/${segments.map(() => placeholder).join('/')}`;
}

function displayQuery(search: string): string {
  if (search === '') {
    return '';
  }
  const query = search.startsWith('?') ? search.slice(1) : search;
  const names: string[] = [];
  for (const name of new URLSearchParams(query).keys()) {
    names.push(name);
  }
  if (names.length === 0) {
    return '';
  }
  // The names are re-encoded, so a name that carries a separator cannot make
  // the display look like more parameters than the URL really has.
  return `?${names.map((name) => `${encodeURIComponent(name)}=${QUERY_VALUE_PLACEHOLDER}`).join('&')}`;
}

/**
 * Renders a URL for display without leaking anything sensitive.
 *
 * The userinfo and the fragment are removed, every query value is replaced by
 * a fixed placeholder, and a path that no approved route covers is shown as
 * redacted path placeholders. Dynamic path segments can hold secrets too, so
 * nothing else is shown.
 */
export function safeDisplayUrl(raw: string, options: SafeDisplayOptions = {}): string {
  const parsed = parseForDisplay(raw);
  if (parsed === null) {
    return UNUSABLE_DISPLAY;
  }
  const placeholder = options.placeholder ?? DEFAULT_PATH_PLACEHOLDER;
  const path = displayPath(displaySegments(parsed.pathname), options.approvedRoutes ?? [], placeholder);
  return `${parsed.protocol}//${parsed.host}${path}${displayQuery(parsed.search)}`;
}
