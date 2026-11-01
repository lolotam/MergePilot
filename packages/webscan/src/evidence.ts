/**
 * Canonical evidence fingerprints (ADR-0052 section 9).
 *
 * A finding carries an `evidenceHash`: a versioned SHA-256 digest of a
 * check-specific canonical tuple. The tuple is built only from
 * catalogue-approved, structurally sanitized facts. Raw bodies, raw header
 * values, request ids, timestamps, nonces and sample ordering are never hash
 * inputs, so a volatile change on the site does not silently invalidate a
 * granted exception, while a real change (an exposed file whose content
 * digest moved) does.
 */

import { createHash } from 'node:crypto';

import type { CheckId } from './types.js';

/** The version of the canonical evidence tuple. Bump it when the tuple changes. */
export const EVIDENCE_HASH_VERSION = 1;

/** The structural facts one finding is allowed to carry. */
export type EvidenceFacts = Readonly<Record<string, string | number | boolean>>;

/**
 * Fact keys whose value is volatile by nature.
 *
 * A volatile field never takes part in the fingerprint: a site that rotates a
 * nonce or stamps a timestamp must not invalidate an exception on its own.
 */
const VOLATILE_FACT_KEYS: ReadonlySet<string> = new Set([
  'nonce',
  'nonces',
  'timestamp',
  'observed_at',
  'request_id',
  'sample_id',
  'sample_index',
  'sample_order',
]);

/** The canonical tuple of one occurrence. */
export interface EvidenceTuple {
  readonly checkId: CheckId;
  readonly issueId: string;
  /** The stable subject of the occurrence (a header, a cookie name, a file). */
  readonly subject: string;
  readonly facts: EvidenceFacts;
}

/** Length-prefixes a field so no value can imitate a separator. */
function encodeField(value: string): string {
  return `${value.length}:${value}`;
}

/** Compares by UTF-16 code unit so the order never depends on the locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Builds the canonical string of one tuple.
 *
 * The facts are sorted by key, volatile keys are dropped, and every field is
 * length-prefixed. The result is stable across runs and across hosts.
 */
export function canonicalEvidenceTuple(tuple: EvidenceTuple): string {
  const keys = Object.keys(tuple.facts)
    .filter((key) => !VOLATILE_FACT_KEYS.has(key))
    .sort(compareCodeUnits);
  const parts = [
    encodeField(String(EVIDENCE_HASH_VERSION)),
    encodeField(tuple.checkId),
    encodeField(tuple.issueId),
    encodeField(tuple.subject),
  ];
  for (const key of keys) {
    parts.push(encodeField(`${key}=${String(tuple.facts[key])}`));
  }
  return parts.join('|');
}

/**
 * Computes the versioned fingerprint of one occurrence.
 *
 * The digest is the identity an exception is pinned to. It covers exactly the
 * facts of the tuple, so a changed exposed-file digest changes the hash while
 * an irrelevant volatile field leaves it untouched.
 */
export function computeEvidenceHash(tuple: EvidenceTuple): string {
  const canonical = canonicalEvidenceTuple(tuple);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `v${EVIDENCE_HASH_VERSION}:${digest}`;
}
