/**
 * The lock order of the scanner tables.
 *
 * Every transaction that writes more than one scanner table takes its row locks in
 * this order and never in another one:
 *
 *   1. `web_scan_settings` — the one global row of the installation.
 *   2. `web_scan_sites`   — the site row.
 *   3. `web_scans`        — the scan row.
 *   4. `web_scan_occurrences` — the retained ledger rows.
 *   5. `web_scan_exceptions`  — the administrator resolutions.
 *   6. `web_scan_alerts`      — the alert delivery rows.
 *
 * A transaction may skip a level, but it may never take a row of a higher level while
 * it holds a row of a lower one. Two transactions that follow the order cannot deadlock
 * on each other, because the one that waits for a row always waits for the one that
 * holds the earlier row, and that one never waits back.
 *
 * The order fixes two real cycles:
 *
 * - The archive of the retained ledger took the site row and then the settings row,
 *   while the enqueue of a scan took the settings row and then the site row.
 * - The terminal write of a scan took the occurrence rows and then the site row,
 *   while the archive took the site row and then the occurrence rows.
 *
 * A row that is read without a lock to discover the identity of the row to lock next
 * does not break the order: the row is read again after it is locked, and the read
 * value is verified.
 */
export const WEB_SCAN_LOCK_ORDER = [
  'web_scan_settings',
  'web_scan_sites',
  'web_scans',
  'web_scan_occurrences',
  'web_scan_exceptions',
  'web_scan_alerts',
] as const;

/** The tables of the lock order. */
export type WebScanLockTable = (typeof WEB_SCAN_LOCK_ORDER)[number];
