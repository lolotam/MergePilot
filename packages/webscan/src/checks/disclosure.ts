/**
 * The disclosure check (ADR-0052 section 3, check 4).
 *
 * The check reports the product versions a response discloses and the stack
 * traces an error page returns.
 *
 * A version is only reported when it matches a signature of the catalogue. The
 * evidence holds the signature name, never the version itself: a version is a
 * number the site chose, and the fingerprint of the occurrence must not carry
 * it. A stack trace is a structural observation, so it never rises above
 * "Likely", and no line of the trace is ever kept.
 */

import type { CheckEvaluation, CheckEvaluationContext } from '../evaluation.js';
import type { OccurrenceFinding } from '../types.js';
import { STACK_TRACE_SIGNATURE_NAMES } from './catalogue.js';
import { buildFinding, coverageRow, decodeBody, safeLocationOf } from './shared.js';

/** One product whose version a header may disclose. */
interface ProductSignature {
  readonly id: string;
  readonly header: 'server' | 'x-powered-by';
  readonly token: string;
}

/** The products the catalogue knows. */
const PRODUCT_SIGNATURES: readonly ProductSignature[] = [
  { id: 'openresty', header: 'server', token: 'openresty' },
  { id: 'microsoft-iis', header: 'server', token: 'microsoft-iis' },
  { id: 'lighttpd', header: 'server', token: 'lighttpd' },
  { id: 'werkzeug', header: 'server', token: 'werkzeug' },
  { id: 'gunicorn', header: 'server', token: 'gunicorn' },
  { id: 'tomcat', header: 'server', token: 'tomcat' },
  { id: 'jetty', header: 'server', token: 'jetty' },
  { id: 'cowboy', header: 'server', token: 'cowboy' },
  { id: 'envoy', header: 'server', token: 'envoy' },
  { id: 'caddy', header: 'server', token: 'caddy' },
  { id: 'apache', header: 'server', token: 'apache' },
  { id: 'nginx', header: 'server', token: 'nginx' },
  { id: 'asp.net', header: 'x-powered-by', token: 'asp.net' },
  { id: 'express', header: 'x-powered-by', token: 'express' },
  { id: 'django', header: 'x-powered-by', token: 'django' },
  { id: 'laravel', header: 'x-powered-by', token: 'laravel' },
  { id: 'php', header: 'x-powered-by', token: 'php' },
];

/** One stack trace the catalogue knows. */
interface StackTraceSignature {
  readonly id: string;
  readonly pattern: RegExp;
}

/** The stack traces the catalogue knows. */
const STACK_TRACE_SIGNATURES: readonly StackTraceSignature[] = [
  { id: STACK_TRACE_SIGNATURE_NAMES.php, pattern: /(fatal error|parse error|stack trace):/i },
  { id: STACK_TRACE_SIGNATURE_NAMES.python, pattern: /traceback \(most recent call last\)/i },
  {
    id: STACK_TRACE_SIGNATURE_NAMES.java,
    pattern: /\bat [a-z0-9_.$]+\([A-Za-z0-9_$]+\.java:\d+\)|\bjava\.lang\.[A-Za-z]+Exception\b/,
  },
  {
    id: STACK_TRACE_SIGNATURE_NAMES.dotnet,
    pattern: /\bSystem\.[A-Za-z]+Exception\b|\bin [A-Za-z0-9_.]+\(\):line \d+/,
  },
  { id: STACK_TRACE_SIGNATURE_NAMES.node, pattern: /\n\s+at [^\n(]+\([^)]*:\d+:\d+\)/ },
  { id: STACK_TRACE_SIGNATURE_NAMES.rails, pattern: /\bapp\/controllers\/[\w/]+\.rb\b/ },
];

/** The product a header value discloses, or null. */
function matchProduct(header: string, value: string): ProductSignature | null {
  const lowered = value.toLowerCase();
  const candidates = PRODUCT_SIGNATURES.filter((signature) => signature.header === header).sort(
    (left, right) => right.token.length - left.token.length,
  );
  for (const signature of candidates) {
    const index = lowered.indexOf(signature.token);
    if (index === -1) {
      continue;
    }
    // A product without a version discloses no version.
    if (!/^[\s/]v?\d/.test(value.slice(index + signature.token.length))) {
      continue;
    }
    return signature;
  }
  return null;
}

/** The stack trace a body shows, or null. */
function matchStackTrace(body: string): StackTraceSignature | null {
  for (const signature of STACK_TRACE_SIGNATURES) {
    if (signature.pattern.test(body)) {
      return signature;
    }
  }
  return null;
}

/**
 * The disclosure check of one scan.
 *
 * The header issues are evaluated for every page the scan received. The stack
 * trace issue needs the body, so it stays unchecked when the destination of a
 * redirect was denied.
 */
export async function evaluateDisclosure(
  context: CheckEvaluationContext,
): Promise<readonly CheckEvaluation[]> {
  const results: CheckEvaluation[] = [];
  for (const target of context.targets) {
    const findings: OccurrenceFinding[] = [];
    const safeLocation = safeLocationOf(context, target.baselineUrl);
    const evaluatedIssueIds = ['server-version-disclosure', 'powered-by-version-disclosure'];
    const server = target.headers.get('server');
    if (server !== null) {
      const signature = matchProduct('server', server);
      if (signature !== null) {
        findings.push(
          buildFinding({
            context,
            targetKey: target.targetKey,
            checkId: 'disclosure',
            issueId: 'server-version-disclosure',
            subject: 'server',
            safeLocation,
            validation: 'Confirmed',
            confidence: 'high',
            evidence: { header: 'server', signature: signature.id },
          }),
        );
      }
    }
    const poweredBy = target.headers.get('x-powered-by');
    if (poweredBy !== null) {
      const signature = matchProduct('x-powered-by', poweredBy);
      if (signature !== null) {
        findings.push(
          buildFinding({
            context,
            targetKey: target.targetKey,
            checkId: 'disclosure',
            issueId: 'powered-by-version-disclosure',
            subject: 'x-powered-by',
            safeLocation,
            validation: 'Confirmed',
            confidence: 'high',
            evidence: { header: 'x-powered-by', signature: signature.id },
          }),
        );
      }
    }
    if (target.destinationReached) {
      evaluatedIssueIds.push('stack-trace-disclosure');
      const signature = matchStackTrace(decodeBody(target.body));
      if (signature !== null) {
        findings.push(
          buildFinding({
            context,
            targetKey: target.targetKey,
            checkId: 'disclosure',
            issueId: 'stack-trace-disclosure',
            subject: 'stack-trace',
            safeLocation,
            validation: 'Likely',
            confidence: 'medium',
            evidence: { signature: signature.id },
          }),
        );
      }
    }
    const result: CheckEvaluation = {
      coverage: coverageRow({
        targetKey: target.targetKey,
        checkId: 'disclosure',
        evaluatedIssueIds,
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
