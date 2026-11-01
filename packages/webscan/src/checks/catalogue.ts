/**
 * The check catalogue (ADR-0052 sections 3, 4 and 9).
 *
 * The catalogue is the registry of every issue the scanner can report. An
 * issue id, its severity, its validation ceiling and its evaluation meaning
 * are fixed here: changing the meaning of an issue requires a new issue id,
 * never a silent redefinition of an old one.
 *
 * The catalogue also holds the closed vocabularies the checks are allowed to
 * put into evidence. Only these names, booleans and numbers may be persisted.
 */

import type { CheckId, Severity, Validation } from '../types.js';

/** One immutable issue of one check. */
export interface CatalogueIssue {
  readonly issueId: string;
  readonly title: string;
  /** Severity is fixed per issue and never re-derived from the observation. */
  readonly severity: Severity;
  /** The strongest validation this issue may ever carry. */
  readonly validationCeiling: Validation;
}

/** Builds one immutable issue of the catalogue. */
function issue(
  issueId: string,
  title: string,
  severity: Severity,
  validationCeiling: Validation = 'Confirmed',
): CatalogueIssue {
  return Object.freeze({ issueId, title, severity, validationCeiling });
}

/**
 * The check version of every check (provenance).
 *
 * A check version changes when the evaluation of an issue changes. Coverage
 * rows and findings record it so a later comparison can tell "not evaluated"
 * from "evaluated differently".
 */
export const CHECK_VERSIONS: Readonly<Record<CheckId, number>> = Object.freeze({
  headers: 1,
  cookies: 1,
  transport: 1,
  disclosure: 1,
  files: 1,
  active: 1,
});

/** The issue registry, keyed by check. */
export const CATALOGUE: Readonly<Record<CheckId, readonly CatalogueIssue[]>> = Object.freeze({
  headers: Object.freeze([
    issue('missing-strict-transport-security', 'Strict-Transport-Security header is missing', 'medium'),
    issue('invalid-strict-transport-security', 'Strict-Transport-Security header is not usable', 'medium'),
    issue('missing-content-security-policy', 'Content-Security-Policy header is missing', 'medium'),
    issue('invalid-content-security-policy', 'Content-Security-Policy declares no known directive', 'medium'),
    issue('missing-frame-protection', 'Neither X-Frame-Options nor CSP frame-ancestors is present', 'medium'),
    issue('invalid-frame-protection', 'X-Frame-Options is present but not a usable value', 'medium'),
    issue('missing-content-type-options', 'X-Content-Type-Options header is missing', 'low'),
    issue('invalid-content-type-options', 'X-Content-Type-Options header is not nosniff', 'low'),
    issue('missing-referrer-policy', 'Referrer-Policy header is missing', 'low'),
    issue('invalid-referrer-policy', 'Referrer-Policy header is not a known policy', 'low'),
    issue('missing-permissions-policy', 'Permissions-Policy header is missing', 'low'),
    issue('invalid-permissions-policy', 'Permissions-Policy header is not a parsable policy', 'low'),
  ]),
  cookies: Object.freeze([
    issue('cookie-without-secure', 'Cookie is set without the Secure attribute', 'medium'),
    issue('cookie-without-http-only', 'Cookie is set without the HttpOnly attribute', 'medium'),
    issue('cookie-without-same-site', 'Cookie is set without an effective SameSite attribute', 'low'),
  ]),
  transport: Object.freeze([
    issue('http-served-without-redirect', 'The site answers on port 80 without redirecting to HTTPS', 'high'),
    issue('mixed-content', 'An HTTPS page references an HTTP asset', 'medium'),
  ]),
  disclosure: Object.freeze([
    issue('server-version-disclosure', 'Server header discloses a product version', 'low'),
    issue('powered-by-version-disclosure', 'X-Powered-By header discloses a product version', 'low'),
    issue('stack-trace-disclosure', 'An error response discloses a stack trace', 'medium', 'Likely'),
  ]),
  files: Object.freeze([
    issue('git-head-exposed', 'A git metadata file is served', 'high'),
    issue('env-file-exposed', 'An environment file is served', 'critical'),
    issue('server-status-exposed', 'A server status page is served', 'medium'),
    issue('admin-panel-exposed', 'An administration page is served', 'medium'),
    issue('source-map-exposed', 'A source map is served next to a discovered script', 'low'),
    issue('robots-txt-present', 'A robots.txt file is served', 'info', 'Informational'),
    issue('security-txt-present', 'A security.txt file is served', 'info', 'Informational'),
    issue('extra-file-exposed', 'A configured extra path is served', 'medium'),
  ]),
  active: Object.freeze([
    issue('sql-error-indicator', 'A request with an SQL indicator returns a database error', 'medium', 'Likely'),
    issue('reflection-indicator', 'A request with an inert marker reflects that marker', 'low', 'Indicator'),
  ]),
});

/** Looks up one issue. Unknown ids are a programming error, never a finding. */
export function catalogueIssue(checkId: CheckId, issueId: string): CatalogueIssue {
  const found = findCatalogueIssue(checkId, issueId);
  if (found === undefined) {
    throw new Error(`unknown catalogue issue: ${checkId}/${issueId}`);
  }
  return found;
}

/**
 * Looks up one issue, or undefined when the catalogue does not hold it.
 *
 * A retired issue id is an id that left the catalogue. The lookup is what
 * tells a retired occurrence apart from a live one, so a retired id is never
 * turned into a Fixed finding by a version change.
 */
export function findCatalogueIssue(checkId: CheckId, issueId: string): CatalogueIssue | undefined {
  const issues = CATALOGUE[checkId];
  if (issues === undefined) {
    return undefined;
  }
  return issues.find((candidate) => candidate.issueId === issueId);
}

/** One header policy the header check evaluates. */
export interface HeaderPolicy {
  /** The stable subject of the policy. */
  readonly subject: string;
  /** The header that carries the policy. */
  readonly header: string;
  readonly missingIssueId: string;
  readonly invalidIssueId: string;
}

/** The single-header policies, evaluated in this order. */
export const HEADER_POLICIES: readonly HeaderPolicy[] = Object.freeze([
  {
    subject: 'strict-transport-security',
    header: 'strict-transport-security',
    missingIssueId: 'missing-strict-transport-security',
    invalidIssueId: 'invalid-strict-transport-security',
  },
  {
    subject: 'content-security-policy',
    header: 'content-security-policy',
    missingIssueId: 'missing-content-security-policy',
    invalidIssueId: 'invalid-content-security-policy',
  },
  {
    subject: 'content-type-options',
    header: 'x-content-type-options',
    missingIssueId: 'missing-content-type-options',
    invalidIssueId: 'invalid-content-type-options',
  },
  {
    subject: 'referrer-policy',
    header: 'referrer-policy',
    missingIssueId: 'missing-referrer-policy',
    invalidIssueId: 'invalid-referrer-policy',
  },
  {
    subject: 'permissions-policy',
    header: 'permissions-policy',
    missingIssueId: 'missing-permissions-policy',
    invalidIssueId: 'invalid-permissions-policy',
  },
]);

/** The frame protection policy spans two headers. */
export const FRAME_POLICY = Object.freeze({
  subject: 'frame-protection',
  header: 'x-frame-options',
  missingIssueId: 'missing-frame-protection',
  invalidIssueId: 'invalid-frame-protection',
});

/** The known referrer policy values (a closed vocabulary). */
export const KNOWN_REFERRER_POLICIES: ReadonlySet<string> = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

/** The known CSP directive names (a closed vocabulary). */
export const KNOWN_CSP_DIRECTIVES: ReadonlySet<string> = new Set([
  'allow',
  'base-uri',
  'block-all-mixed-content',
  'child-src',
  'connect-src',
  'default-src',
  'fenced-frame-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'navigate-to',
  'object-src',
  'plugin-types',
  'prefetch-src',
  'report-to',
  'report-uri',
  'require-trusted-types-for',
  'sandbox',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'trusted-types',
  'upgrade-insecure-requests',
  'worker-src',
]);

/** The safe signature names of the stack trace detection. */
export const STACK_TRACE_SIGNATURE_NAMES = Object.freeze({
  php: 'php-stack-trace',
  python: 'python-traceback',
  java: 'java-stack-trace',
  dotnet: 'dotnet-stack-trace',
  node: 'node-stack-trace',
  rails: 'rails-stack-trace',
});

/** The safe signature names of the database error detection. */
export const SQL_SIGNATURE_NAMES = Object.freeze({
  syntax: 'sql-syntax-error',
  mysql: 'sql-mysql-error',
  postgres: 'sql-postgres-error',
  sqlite: 'sql-sqlite-error',
  unclosedQuote: 'sql-unclosed-quote',
  oracle: 'sql-ora-error',
});

/** The safe signature names of the exposed-file check. */
export const FILE_SIGNATURE_NAMES = Object.freeze({
  gitHeadRef: 'git-head-ref',
  gitHeadText: 'git-head-text',
  envAssignments: 'env-assignments',
  envText: 'env-text',
  apacheServerStatus: 'apache-server-status',
  serverStatusText: 'server-status-text',
  adminInterface: 'admin-interface',
  adminHtml: 'admin-html',
  robotsTxt: 'robots-txt',
  robotsDirectives: 'robots-directives',
  securityTxt: 'security-txt',
  securityTxtFields: 'security-txt-fields',
  sourceMap: 'source-map',
  sourceMapText: 'source-map-text',
  fileContent: 'file-content',
});

/** One exposed-file kind of the file catalogue. */
export interface ExposedFileKind {
  /** The fixed path, or an empty string for a kind without a fixed path. */
  readonly path: string;
  readonly issueId: string;
  readonly severity: Severity;
  readonly validationCeiling: Validation;
  /** The signature that confirms the exposure. */
  readonly strongSignature: string;
  /** The signature of a weaker indication, or null when there is none. */
  readonly weakSignature: string | null;
}

/** The fixed file paths of the file check. */
export const EXPOSED_FILE_KINDS: readonly ExposedFileKind[] = Object.freeze([
  {
    path: '/.git/HEAD',
    issueId: 'git-head-exposed',
    severity: 'high',
    validationCeiling: 'Confirmed',
    strongSignature: FILE_SIGNATURE_NAMES.gitHeadRef,
    weakSignature: FILE_SIGNATURE_NAMES.gitHeadText,
  },
  {
    path: '/.env',
    issueId: 'env-file-exposed',
    severity: 'critical',
    validationCeiling: 'Confirmed',
    strongSignature: FILE_SIGNATURE_NAMES.envAssignments,
    weakSignature: FILE_SIGNATURE_NAMES.envText,
  },
  {
    path: '/server-status',
    issueId: 'server-status-exposed',
    severity: 'medium',
    validationCeiling: 'Confirmed',
    strongSignature: FILE_SIGNATURE_NAMES.apacheServerStatus,
    weakSignature: FILE_SIGNATURE_NAMES.serverStatusText,
  },
  {
    path: '/admin/',
    issueId: 'admin-panel-exposed',
    severity: 'medium',
    validationCeiling: 'Confirmed',
    strongSignature: FILE_SIGNATURE_NAMES.adminInterface,
    weakSignature: FILE_SIGNATURE_NAMES.adminHtml,
  },
  {
    path: '/robots.txt',
    issueId: 'robots-txt-present',
    severity: 'info',
    validationCeiling: 'Informational',
    strongSignature: FILE_SIGNATURE_NAMES.robotsTxt,
    weakSignature: FILE_SIGNATURE_NAMES.robotsDirectives,
  },
  {
    path: '/security.txt',
    issueId: 'security-txt-present',
    severity: 'info',
    validationCeiling: 'Informational',
    strongSignature: FILE_SIGNATURE_NAMES.securityTxt,
    weakSignature: FILE_SIGNATURE_NAMES.securityTxtFields,
  },
]);

/** The kind of a source map derived from a discovered script. */
export const SOURCE_MAP_KIND: ExposedFileKind = Object.freeze({
  path: '',
  issueId: 'source-map-exposed',
  severity: 'low',
  validationCeiling: 'Confirmed',
  strongSignature: FILE_SIGNATURE_NAMES.sourceMap,
  weakSignature: FILE_SIGNATURE_NAMES.sourceMapText,
});

/** The kind of an administrator-configured extra path. */
export const EXTRA_FILE_KIND: ExposedFileKind = Object.freeze({
  path: '',
  issueId: 'extra-file-exposed',
  severity: 'medium',
  validationCeiling: 'Confirmed',
  strongSignature: FILE_SIGNATURE_NAMES.fileContent,
  weakSignature: null,
});

/** The safe content categories a response body may be classified as. */
export const CONTENT_CATEGORIES = Object.freeze([
  'html',
  'json',
  'script',
  'text',
  'binary',
  'unknown',
] as const);

/** One content category. */
export type ContentCategory = (typeof CONTENT_CATEGORIES)[number];

/** The safe reflection forms of the active check. */
export const REFLECTION_FORMS = Object.freeze([
  'full',
  'encoded',
  'partial',
  'attribute',
] as const);

/** One reflection form. */
export type ReflectionForm = (typeof REFLECTION_FORMS)[number];
