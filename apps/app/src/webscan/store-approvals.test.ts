import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { webScanSettings } from '../db/schema.js';
import {
  WebScanConflictError,
  WebScanNotFoundError,
  WEB_SCAN_MAX_APPROVED_INSTALLATIONS,
} from './store.js';
import { fixture } from './store.fixtures.js';
import type { PgWebScanStore } from './pg-store.js';
import type { TestDbHandle } from '../db/test-db.js';

/**
 * The tests of the approved installations of the store (ADR-0052 section 8).
 *
 * The approval is the only write of the list, and it is written with its audit
 * row in one transaction.
 */

const ENTRY = { adminUserId: 'admin-1', installationId: 42, githubAccountId: 7 };

describe('the approved installations of the settings', () => {
  let db: TestDbHandle;
  let store: PgWebScanStore;

  beforeAll(async () => {
    const handle = await fixture();
    db = handle.db;
    store = handle.store;
  });

  beforeEach(async () => {
    // The list is emptied between the tests, so every test starts from the state
    // the migration seeds. The audit log is append-only, so its rows are never
    // removed: every test counts the rows it wrote itself.
    await db.db.update(webScanSettings).set({ approvedInstallations: [], updatedBy: null });
  });

  /** The audit rows of the settings that the test itself wrote. */
  const auditRowsOfThisTest = async (before: number) => {
    const audit = await store.listAudit({ targetType: 'settings' });
    return audit.slice(0, Math.max(0, audit.length - before));
  };

  it('writes an approval and its audit row together', async () => {
    const updated = await store.approveInstallation('admin-1', ENTRY);
    expect(updated.approvedInstallations).toEqual([ENTRY]);
    expect(updated.updatedBy).toBe('admin-1');

    const audit = await store.listAudit({ targetType: 'settings' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('settings.approve_installation');
    expect(audit[0]?.actor).toBe('admin-1');
  });

  it('writes the approval of one installation once', async () => {
    await store.approveInstallation('admin-1', ENTRY);
    const again = await store.approveInstallation('admin-1', ENTRY);
    expect(again.approvedInstallations).toEqual([ENTRY]);

    // A second administrator has an entry of their own.
    const other = await store.approveInstallation('admin-2', {
      adminUserId: 'admin-2',
      installationId: 42,
      githubAccountId: 7,
    });
    expect(other.approvedInstallations).toHaveLength(2);
  });

  it('replaces the entry of an installation whose account changed', async () => {
    await store.approveInstallation('admin-1', ENTRY);
    const updated = await store.approveInstallation('admin-1', {
      adminUserId: 'admin-1',
      installationId: 42,
      githubAccountId: 9,
    });
    expect(updated.approvedInstallations).toEqual([
      { adminUserId: 'admin-1', installationId: 42, githubAccountId: 9 },
    ]);
  });

  it('removes an approval and writes its audit row', async () => {
    await store.approveInstallation('admin-1', ENTRY);
    const before = (await store.listAudit({ targetType: 'settings' })).length;
    const updated = await store.revokeInstallationApproval('admin-1', 'admin-1', 42);
    expect(updated.approvedInstallations).toEqual([]);

    const rows = await auditRowsOfThisTest(before);
    expect(rows.map((row) => row.action)).toEqual(['settings.revoke_installation']);
  });

  it('refuses to remove an approval that is not there', async () => {
    const before = (await store.listAudit({ targetType: 'settings' })).length;
    let caught: unknown = null;
    try {
      await store.revokeInstallationApproval('admin-1', 'admin-1', 42);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebScanNotFoundError);

    expect(await auditRowsOfThisTest(before)).toEqual([]);
  });

  it('leaves the list alone when the settings change', async () => {
    await store.approveInstallation('admin-1', ENTRY);
    const updated = await store.updateSettings('admin-1', { paused: false });
    expect(updated.approvedInstallations).toEqual([ENTRY]);
  });

  it('refuses to grow the list past its bound', async () => {
    for (let index = 0; index < WEB_SCAN_MAX_APPROVED_INSTALLATIONS; index += 1) {
      await store.approveInstallation('admin-1', {
        adminUserId: 'admin-1',
        installationId: 1000 + index,
        githubAccountId: 7,
      });
    }

    let caught: unknown = null;
    try {
      await store.approveInstallation('admin-1', {
        adminUserId: 'admin-1',
        installationId: 9999,
        githubAccountId: 7,
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebScanConflictError);

    const settings = await store.getSettings();
    expect(settings.approvedInstallations).toHaveLength(WEB_SCAN_MAX_APPROVED_INSTALLATIONS);
  });
});
