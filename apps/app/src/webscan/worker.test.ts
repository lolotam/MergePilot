import { describe, expect, it, vi } from 'vitest';
import { processScanJob, type WebScanWorkerDeps } from './worker.js';
import type { WebScanScan } from './types.js';
import { harness, observation, scan } from './worker.fixtures.js';

/**
 * The scan worker (ADR-0052 sections 5 and 7).
 *
 * The worker never runs a scan twice, never starts a scan without a current
 * authorization, never runs a scan under settings nobody approved for it and never
 * writes an outcome that another attempt owns.
 */

describe('the scan worker', () => {
  it('never runs a scan that already has a terminal state', async () => {
    const h = harness({ scan: { ...scan, status: 'completed' } as WebScanScan });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('terminal');
    expect(h.runScan).not.toHaveBeenCalled();
    expect(h.claimScan).not.toHaveBeenCalled();
  });

  it('does nothing when the scan does not exist', async () => {
    const h = harness({ scan: null });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('missing');
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('stops a queued scan without a single request while the kill switch is on', async () => {
    const h = harness({ paused: true });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.stopQueuedScan).toHaveBeenCalledWith({
      scanId: 'scan-1',
      reason: 'kill_switch',
      now: expect.any(Date),
    });
    expect(h.runScan).not.toHaveBeenCalled();
    expect(h.claimScan).not.toHaveBeenCalled();
  });

  it('stops the scan when the authorizing administrator is gone', async () => {
    const h = harness({ administrator: null });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.stopQueuedScan).toHaveBeenCalledWith({
      scanId: 'scan-1',
      reason: 'authorization_revoked',
      now: expect.any(Date),
    });
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('stops the scan when the email of the administrator is not verified', async () => {
    const h = harness({
      administrator: { id: 'admin-1', email: 'admin@example.com', emailVerified: false },
    });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('stops the scan when the administrator is no longer a platform admin', async () => {
    const h = harness({ platformAdmins: ['someone-else@example.com'] });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('claims the scan, runs it and writes the outcome', async () => {
    const h = harness();

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('completed');
    expect(h.claimScan).toHaveBeenCalledWith({
      scanId: 'scan-1',
      attemptId: expect.any(String),
      now: expect.any(Date),
    });
    expect(h.runScan).toHaveBeenCalledTimes(1);
    expect(h.recordScanOutcomeAttempt).toHaveBeenCalledTimes(1);
    const outcome = h.recordScanOutcomeAttempt.mock.calls[0]?.[1];
    expect(outcome).toMatchObject({ scanId: 'scan-1', siteId: 'site-1', status: 'completed' });
  });

  it('does nothing when another worker already claimed the scan', async () => {
    const h = harness({ claimResult: null });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('not_claimed');
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('re-reads the live state before every outbound request', async () => {
    const h = harness();

    await processScanJob('scan-1', h.deps);

    expect(h.readLiveScanState).toHaveBeenCalled();
  });

  it('stops the scan when the kill switch closes between the claim and the request', async () => {
    const h = harness();
    h.readLiveScanState.mockResolvedValue({
      paused: true,
      administrator: { id: 'admin-1', email: 'admin@example.com', emailVerified: true },
      removed: false,
      authorized: true,
    });

    // The scan runner asks for the transport and the worker refuses it.
    h.deps.runScan = vi.fn(async (_input, scanDeps) => {
      await scanDeps.fetch('https://example.com/');
      return observation;
    }) as unknown as WebScanWorkerDeps['runScan'];

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('stopped');
    // The scan still reaches a terminal state.
    expect(h.recordScanOutcomeAttempt).toHaveBeenCalledTimes(1);
    expect(h.recordScanOutcomeAttempt.mock.calls[0]?.[1]).toMatchObject({
      status: 'stopped',
      stopReason: 'kill_switch',
    });
  });

  it('fails the scan when the identity key of the site cannot be opened', async () => {
    const h = harness({ identityKey: null });

    await expect(processScanJob('scan-1', h.deps)).resolves.toBe('failed');
    // The scan does not stay running until the reconciliation finds it.
    expect(h.recordScanOutcomeAttempt).toHaveBeenCalledTimes(1);
    expect(h.recordScanOutcomeAttempt.mock.calls[0]?.[1]).toMatchObject({
      status: 'failed',
      failReason: 'identity_key_missing',
    });
    expect(h.runScan).not.toHaveBeenCalled();
  });
});
