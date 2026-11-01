import type { ScannerEnvelopeStore, ScannerIdentityEnvelope } from './rotate.js';

/**
 * An in-memory scanner envelope store for tests.
 *
 * It mirrors the persistence the Postgres scanner store does, so a rotation
 * test can assert that every identity envelope was rewrapped without a
 * database.
 */
export class MemoryScannerEnvelopeStore implements ScannerEnvelopeStore {
  readonly envelopes = new Map<string, ScannerIdentityEnvelope>();

  constructor(initial: readonly ScannerIdentityEnvelope[] = []) {
    for (const envelope of initial) {
      this.envelopes.set(envelope.siteId, { ...envelope });
    }
  }

  async listIdentityEnvelopes(): Promise<readonly ScannerIdentityEnvelope[]> {
    return [...this.envelopes.values()].map((envelope) => ({ ...envelope }));
  }

  async saveIdentityEnvelope(siteId: string, ciphertext: string, keyVersion: number): Promise<void> {
    this.envelopes.set(siteId, { siteId, ciphertext, keyVersion });
  }
}
