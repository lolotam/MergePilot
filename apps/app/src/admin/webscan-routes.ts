import type { FastifyInstance } from 'fastify';
import type { WebScanEventBus } from '../webscan/events.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanAdminGuard } from './webscan-http.js';
import { registerWebScanAuditRoutes } from './webscan-audit.js';
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
 *
 * The injected `events` bus belongs to the live SSE routes (Task 8B); the Task 8A
 * routes carry it so a later registration needs no signature change.
 */

/**
 * The offset page of the scanner routes lives in the HTTP contract
 * (`contract-webscan.ts`): both handlers and response schemas must agree on it.
 */

/** The scanner dependencies the routes read: the store and, later, its event bus. */
export interface WebScanRouteDeps {
  store: WebScanStore;
  events: WebScanEventBus;
}

/**
 * Registers the Task 8 routes. The Task 8B routes (scans, events, exports,
 * exceptions) extend this function, not the admin route file.
 */
export function registerWebScanRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  deps: WebScanRouteDeps,
): void {
  registerWebScanSettingsRoutes(app, guard, deps.store);
  registerWebScanSitesRoutes(app, guard, deps.store);
  registerWebScanAuditRoutes(app, guard, deps.store);
}
