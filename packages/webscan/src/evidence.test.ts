import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_HASH_VERSION,
  canonicalEvidenceTuple,
  computeEvidenceHash,
  type EvidenceTuple,
} from './evidence.js';

function tuple(overrides: Partial<EvidenceTuple> = {}): EvidenceTuple {
  return {
    checkId: 'files',
    issueId: 'env-file-exposed',
    subject: '/.env',
    facts: {
      status: 200,
      content_type: 'text',
      length: 42,
      signature: 'env-assignments',
      digest: 'a'.repeat(64),
    },
    ...overrides,
  };
}

describe('the evidence fingerprint', () => {
  it('is the same for the same facts', () => {
    expect(computeEvidenceHash(tuple())).toBe(computeEvidenceHash(tuple()));
  });

  it('does not depend on the order of the facts', () => {
    const ordered = computeEvidenceHash(
      tuple({ facts: { status: 200, length: 42, signature: 'env-assignments' } }),
    );
    const shuffled = computeEvidenceHash(
      tuple({ facts: { signature: 'env-assignments', length: 42, status: 200 } }),
    );

    expect(ordered).toBe(shuffled);
  });

  it('changes when a fact changes', () => {
    const before = computeEvidenceHash(tuple());
    const after = computeEvidenceHash(
      tuple({ facts: { ...tuple().facts, length: 43 } }),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the content of an exposed file changed', () => {
    const before = computeEvidenceHash(tuple());
    const after = computeEvidenceHash(
      tuple({ facts: { ...tuple().facts, digest: 'b'.repeat(64) } }),
    );

    expect(after).not.toBe(before);
  });

  it('ignores a volatile field, so a rotating nonce keeps the exception', () => {
    const before = computeEvidenceHash(tuple());
    const after = computeEvidenceHash(
      tuple({ facts: { ...tuple().facts, nonce: 'rotating-value-1', timestamp: 17 } }),
    );

    expect(after).toBe(before);
  });

  it('ignores the order of a sample of findings', () => {
    const before = computeEvidenceHash(tuple());
    const after = computeEvidenceHash(
      tuple({ facts: { ...tuple().facts, sample_order: 3, sample_index: 9 } }),
    );

    expect(after).toBe(before);
  });

  it('separates two issues of the same check', () => {
    const before = computeEvidenceHash(tuple());
    const after = computeEvidenceHash(tuple({ issueId: 'git-head-exposed' }));

    expect(after).not.toBe(before);
  });

  it('carries its version', () => {
    expect(computeEvidenceHash(tuple())).toContain(`v${EVIDENCE_HASH_VERSION}:`);
    expect(canonicalEvidenceTuple(tuple())).toContain(String(EVIDENCE_HASH_VERSION));
  });

  it('cannot be forged by a value that imitates a separator', () => {
    const before = canonicalEvidenceTuple(tuple({ facts: { a: 'b' } }));
    const after = canonicalEvidenceTuple(tuple({ facts: { 'a=b': 'c' } }));

    expect(before).not.toBe(after);
  });
});
