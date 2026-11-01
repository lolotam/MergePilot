/**
 * The cookie check (ADR-0052 section 3, check 2).
 *
 * The check reports the attributes of the cookies a response sets. A cookie
 * value never reaches a finding and never reaches a fingerprint: only the
 * name of the cookie and the attribute flags are kept, and the name is the
 * subject of the occurrence, so two different cookies stay two different
 * occurrences.
 */

import type { CheckEvaluation, CheckEvaluationContext } from '../evaluation.js';
import type { OccurrenceFinding } from '../types.js';
import { buildFinding, coverageRow, safeLocationOf } from './shared.js';

/** Every issue the cookie check evaluates. */
const COOKIE_ISSUE_IDS: readonly string[] = [
  'cookie-without-secure',
  'cookie-without-http-only',
  'cookie-without-same-site',
];

/** The effective same-site policy of a cookie. */
type SameSite = 'Strict' | 'Lax' | 'None' | 'unset';

/** The attributes of one cookie. */
interface ParsedCookie {
  readonly name: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: SameSite;
}

/**
 * Parses one `Set-Cookie` header.
 *
 * The value of the cookie is deliberately not read: only the name and the
 * attribute flags are extracted.
 */
function parseSetCookie(raw: string): ParsedCookie | null {
  const parts = raw.split(';');
  const first = parts[0] ?? '';
  const separator = first.indexOf('=');
  if (separator <= 0) {
    return null;
  }
  const name = first.slice(0, separator).trim();
  if (name === '') {
    return null;
  }
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = 'unset';
  for (const part of parts.slice(1)) {
    const attribute = part.trim();
    if (attribute === '') {
      continue;
    }
    const equals = attribute.indexOf('=');
    const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const value = equals === -1 ? '' : attribute.slice(equals + 1).trim().toLowerCase();
    if (key === 'secure') {
      secure = true;
    } else if (key === 'httponly') {
      httpOnly = true;
    } else if (key === 'samesite') {
      sameSite =
        value === 'strict' ? 'Strict' : value === 'lax' ? 'Lax' : value === 'none' ? 'None' : 'unset';
    }
  }
  return { name, secure, httpOnly, sameSite };
}

/**
 * The cookie check of one scan.
 *
 * Every `Set-Cookie` header of every received response is evaluated. The
 * headers of an authorized 3xx are evaluated as they arrived, even when the
 * destination was denied.
 */
export async function evaluateCookies(
  context: CheckEvaluationContext,
): Promise<readonly CheckEvaluation[]> {
  const results: CheckEvaluation[] = [];
  for (const target of context.targets) {
    const findings: OccurrenceFinding[] = [];
    const safeLocation = safeLocationOf(context, target.baselineUrl);
    const reported = new Set<string>();
    for (const raw of target.headers.getSetCookie()) {
      const cookie = parseSetCookie(raw);
      if (cookie === null) {
        continue;
      }
      const evidence = {
        name: cookie.name,
        secure: cookie.secure,
        http_only: cookie.httpOnly,
        same_site: cookie.sameSite,
      };
      const report = (issueId: string): void => {
        // The subject of a cookie is its name: two cookies of the same name are
        // one subject, so the occurrence is reported once.
        if (reported.has(`${issueId}|${cookie.name}`)) {
          return;
        }
        reported.add(`${issueId}|${cookie.name}`);
        findings.push(
          buildFinding({
            context,
            targetKey: target.targetKey,
            checkId: 'cookies',
            issueId,
            subject: cookie.name,
            safeLocation,
            validation: 'Confirmed',
            confidence: 'high',
            evidence,
          }),
        );
      };
      if (!cookie.secure) {
        report('cookie-without-secure');
      }
      if (!cookie.httpOnly) {
        report('cookie-without-http-only');
      }
      if (cookie.sameSite === 'unset') {
        report('cookie-without-same-site');
      }
    }
    const result: CheckEvaluation = {
      coverage: coverageRow({
        targetKey: target.targetKey,
        checkId: 'cookies',
        evaluatedIssueIds: COOKIE_ISSUE_IDS,
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
