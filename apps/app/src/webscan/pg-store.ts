import { eq } from 'drizzle-orm';
import type { RetainedOccurrence } from '@mergepilot/webscan';
import type { AppDb } from '../db/pg-store.js';
import { webScanSites } from '../db/schema.js';
import { WEBSCAN_IDENTITY_PURPOSE, type ScopedSecretVault } from '../vault/scoped-secrets.js';
import type { ScannerEnvelopeStore, ScannerIdentityEnvelope } from '../vault/rotate.js';
import { countAudit, listAudit, readAuditEntry } from './pg-audit.js';
import { listAlerts, setSiteAlertEpisodes, upsertAlert } from './pg-alerts.js';
import {
  createException,
  listExceptions,
  listLiveExceptions,
  restoreExpiredExceptionOccurrences,
  revokeException,
} from './pg-exceptions.js';
import {
  archiveUnprovenOccurrences,
  listOccurrences,
  listRetainedOccurrences,
  pruneProvenFixedTombstones,
} from './pg-occurrences.js';
import { listScanFindings, recordScanOutcome } from './pg-outcome.js';
import {
  enqueueManualScan,
  enqueueScheduledScan,
  listScans,
  readScan,
  stopScan,
} from './pg-scans.js';
import { createSite, listSites, readSite, readSiteByHostname, removeSite, updateSite } from './pg-sites.js';
import { readScanSettings, updateScanSettings } from './pg-settings.js';
import type {
  CreateWebScanExceptionInput,
  CreateWebScanSiteInput,
  EnqueueManualWebScanInput,
  EnqueueScheduledWebScanInput,
  EnqueueWebScanResult,
  RecordWebScanOutcomeInput,
  StopWebScanResult,
  UpdateWebScanSiteInput,
  UpsertWebScanAlertInput,
  WebScanStore,
  WebScanSettingsPatch,
} from './store.js';
import type {
  WebScanAlert,
  WebScanAlertEpisode,
  WebScanAuditEntry,
  WebScanException,
  WebScanOccurrence,
  WebScanScan,
  WebScanScanFinding,
  WebScanSettings,
  WebScanSite,
} from './types.js';

/**
 * The Postgres store of the website security scanner (ADR-0052).
 *
 * It is a focused store: the tenant-scoped `AppStore` stays untouched, and the
 * scanner gets its own object that the routes, the worker and the retention job get
 * injected.
 *
 * Every method that changes state writes its audit row in the same transaction.
 */
export class PgWebScanStore implements WebScanStore, ScannerEnvelopeStore {
  constructor(
    private readonly db: AppDb,
    private readonly secretVault: ScopedSecretVault,
  ) {}

  // -- The global settings -------------------------------------------------

  async getSettings(): Promise<WebScanSettings> {
    return readScanSettings(this.db);
  }

  async updateSettings(actor: string, patch: WebScanSettingsPatch): Promise<WebScanSettings> {
    return updateScanSettings(this.db, actor, patch);
  }

  // -- The sites ------------------------------------------------------------

  async listSites(options?: { includeRemoved?: boolean }): Promise<WebScanSite[]> {
    return listSites(this.db, options);
  }

  async getSite(siteId: string): Promise<WebScanSite | null> {
    return readSite(this.db, siteId);
  }

  async getSiteByHostname(hostname: string): Promise<WebScanSite | null> {
    return readSiteByHostname(this.db, hostname);
  }

  async createSite(actor: string, input: CreateWebScanSiteInput): Promise<WebScanSite> {
    return createSite(this.db, actor, input, this.secretVault);
  }

  async updateSite(
    actor: string,
    siteId: string,
    input: UpdateWebScanSiteInput,
  ): Promise<WebScanSite> {
    return updateSite(this.db, actor, siteId, input);
  }

  async removeSite(actor: string, siteId: string): Promise<WebScanSite> {
    return removeSite(this.db, actor, siteId);
  }

  // -- The scans ------------------------------------------------------------

  async enqueueManualScan(
    actor: string,
    input: EnqueueManualWebScanInput,
  ): Promise<EnqueueWebScanResult> {
    return enqueueManualScan(this.db, actor, input);
  }

  async enqueueScheduledScan(
    actor: string,
    input: EnqueueScheduledWebScanInput,
  ): Promise<WebScanScan> {
    return enqueueScheduledScan(this.db, actor, input);
  }

  async getScan(scanId: string): Promise<WebScanScan | null> {
    return readScan(this.db, scanId);
  }

  async listScans(siteId: string): Promise<WebScanScan[]> {
    return listScans(this.db, siteId);
  }

  async listScanFindings(scanId: string): Promise<WebScanScanFinding[]> {
    return listScanFindings(this.db, scanId);
  }

  async stopScan(actor: string, scanId: string): Promise<StopWebScanResult> {
    return stopScan(this.db, actor, scanId);
  }

  // -- The retained ledger --------------------------------------------------

  async listRetainedOccurrences(siteId: string): Promise<RetainedOccurrence[]> {
    return listRetainedOccurrences(this.db, siteId);
  }

  async listOccurrences(siteId: string): Promise<WebScanOccurrence[]> {
    return listOccurrences(this.db, siteId);
  }

  async recordScanOutcome(actor: string, input: RecordWebScanOutcomeInput): Promise<void> {
    return recordScanOutcome(this.db, actor, input);
  }

  async archiveUnprovenOccurrences(siteId: string): Promise<number> {
    return archiveUnprovenOccurrences(this.db, siteId);
  }

  async pruneProvenFixedTombstones(siteId: string): Promise<number> {
    return pruneProvenFixedTombstones(this.db, siteId);
  }

  // -- The administrator resolutions ---------------------------------------

  async listExceptions(siteId: string): Promise<WebScanException[]> {
    return listExceptions(this.db, siteId);
  }

  async listLiveExceptions(siteId: string, at: Date): Promise<WebScanException[]> {
    return listLiveExceptions(this.db, siteId, at);
  }

  async createException(
    actor: string,
    input: CreateWebScanExceptionInput,
  ): Promise<WebScanException> {
    return createException(this.db, actor, input);
  }

  async revokeException(actor: string, exceptionId: string): Promise<WebScanException> {
    return revokeException(this.db, actor, exceptionId);
  }

  async restoreExpiredExceptionOccurrences(siteId: string): Promise<number> {
    return restoreExpiredExceptionOccurrences(this.db, siteId);
  }

  // -- The alerts -----------------------------------------------------------

  async listAlerts(siteId: string): Promise<WebScanAlert[]> {
    return listAlerts(this.db, siteId);
  }

  async upsertAlert(input: UpsertWebScanAlertInput): Promise<WebScanAlert> {
    return upsertAlert(this.db, input);
  }

  async setSiteAlertEpisodes(
    actor: string,
    siteId: string,
    episodes: WebScanAlertEpisode[],
  ): Promise<void> {
    return setSiteAlertEpisodes(this.db, actor, siteId, episodes);
  }

  // -- The audit log --------------------------------------------------------

  async listAudit(options?: {
    limit?: number;
    offset?: number;
    targetType?: string;
    targetId?: string;
  }): Promise<WebScanAuditEntry[]> {
    return listAudit(this.db, options);
  }

  async countAudit(options?: { targetType?: string; targetId?: string }): Promise<number> {
    return countAudit(this.db, options);
  }

  async getAuditEntry(auditId: string): Promise<WebScanAuditEntry | null> {
    return readAuditEntry(this.db, auditId);
  }

  // -- The identity keys ----------------------------------------------------

  /**
   * The identity key envelopes of every site.
   *
   * A master-key rotation reads them and rewraps them, so the old master key can
   * never be retired while a scanner identity key is still sealed with it.
   */
  async listIdentityEnvelopes(): Promise<readonly ScannerIdentityEnvelope[]> {
    const rows = await this.db
      .select({
        siteId: webScanSites.id,
        ciphertext: webScanSites.identityKeyCiphertext,
        keyVersion: webScanSites.identityKeyVersion,
      })
      .from(webScanSites);
    return rows.map((row) => ({
      siteId: row.siteId,
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
    }));
  }

  /** Writes a rewrapped identity key envelope. */
  async saveIdentityEnvelope(
    siteId: string,
    ciphertext: string,
    keyVersion: number,
  ): Promise<void> {
    await this.db
      .update(webScanSites)
      .set({ identityKeyCiphertext: ciphertext, identityKeyVersion: keyVersion, updatedAt: new Date() })
      .where(eq(webScanSites.id, siteId));
  }

  /**
   * Opens the identity key of a site.
   *
   * The key is only ever used to derive the per-site fingerprint function of the
   * package. It never leaves this call, and it is never written anywhere.
   */
  async openSiteIdentityKey(siteId: string): Promise<string | null> {
    const rows = await this.db
      .select({
        ciphertext: webScanSites.identityKeyCiphertext,
      })
      .from(webScanSites)
      .where(eq(webScanSites.id, siteId));
    const row = rows[0];
    if (row === undefined) return null;
    return this.secretVault.open(row.ciphertext, {
      purpose: WEBSCAN_IDENTITY_PURPOSE,
      scopeId: siteId,
    });
  }
}
