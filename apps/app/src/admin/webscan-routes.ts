import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/auth.js';
import type { AppConfig } from '../core/config.js';
import type { WebScanEventBus } from '../webscan/events.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanAdminGuard } from './webscan-http.js';
import type { RunStreamOptions } from '../api/runs-events-routes.js';
import { registerWebScanAuditRoutes } from './webscan-audit.js';
import { registerWebScanEventRoutes } from './webscan-events.js';
import { registerWebScanExceptionRoutes } from './webscan-exceptions.js';
import { registerWebScanExportRoutes } from './webscan-exports.js';
import { registerWebScanScanRoutes } from './webscan-scans.js';
import { registerWebScanSettingsRoutes } from './webscan-settings.js';
import { registerWebScanSitesRoutes } from './webscan-sites.js';

/**
 * The platform-admin routes of the website security scanner (ADR-0052).
 *
 * Every route answers the regular 404 to anyone who is not a platform admin: the
 * guard runs before any lookup, any validation and any serialization. The
 * scanner is platform-global, so nothing here is workspace-scoped.
 *
 * This file only registers the route files. The shared HTTP helpers live in
 * `webscan-http.ts`, which imports no route file, so no route file and this
 * file import each other.
 */

/**
 * The offset page of the scanner routes lives in the HTTP contract
 * (`contract-webscan.ts`): both handlers and response schemas must agree on it.
 */

/** The scanner dependencies the routes read: the store, the event bus and the session. */
export interface WebScanRouteDeps {
  store: WebScanStore;
  events: WebScanEventBus;
  /**
   * The live stream re-checks the session itself with the keep-alive, so a session
   * that ends disconnects the stream even while the request is hijacked.
   */
  auth: Auth;
  config: Pick<AppConfig, 'platformAdmins' | 'baseUrl'>;
  /** Test and deployment seam: the limits of the live scan streams. */
  streams?: Partial<RunStreamOptions> | undefined;
}

/**
 * Registers the Task 8 routes: the settings, the sites and the audit log (Task 8A),
 * then the scans, the exceptions, the export and the live events (Task 8B).
 */
export function registerWebScanRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  deps: WebScanRouteDeps,
): void {
  registerWebScanSettingsRoutes(app, guard, deps.store);
  registerWebScanSitesRoutes(app, guard, deps.store);
  registerWebScanAuditRoutes(app, guard, deps.store);
  registerWebScanScanRoutes(app, guard, deps.store);
  registerWebScanExceptionRoutes(app, guard, deps.store);
  registerWebScanExportRoutes(app, guard, { store: deps.store, config: deps.config });
  registerWebScanEventRoutes(app, guard, deps);
}
