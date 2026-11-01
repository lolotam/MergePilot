/**
 * The request capability of a check (ADR-0052 section 3).
 *
 * A check may need requests of its own: the cleartext probe of the site, the
 * body of a file that the crawl never read, the baseline of a parameterized
 * link and the probe of the same link. They are not a second scanner:
 *
 * - Every request goes through the *same* client as the crawl, so it shares
 *   the request budget, the pacing, the deadline and the policy.
 * - Every request is bound to its own authorization, so a check cannot read a
 *   path the scope refuses and cannot follow a redirect out of it.
 * - The capability has no general purpose "fetch this URL" method. A check
 *   asks for the kind of request it is allowed to make, and the client checks
 *   it again.
 */

import type { ScanCandidate } from './candidates.js';
import type { ScanClient, ScanClientResponse } from './client.js';
import { ScanPolicyError } from './errors.js';
import { canonicalHostname, evaluateExtraFilePath } from './scope.js';
import type { ScanScope } from './types.js';

/**
 * The fixed paths of the exposed-file catalogue.
 *
 * ADR-0052 section 3 lists them. They are part of the guard, not of a check:
 * a request for a path that is neither one of them nor one of the extra
 * paths of the site is refused.
 */
export const CATALOGUE_FILE_PATHS: readonly string[] = Object.freeze([
  '/.git/HEAD',
  '/.env',
  '/server-status',
  '/admin/',
  '/robots.txt',
  '/security.txt',
]);

/** What a check may ask the scan to request. */
export interface ScanCheckRequester {
  /**
   * The single cleartext request of the scan: the root of the site over
   * HTTP, without a query and without the base path.
   */
  readonly probeRootPort80: () => Promise<ScanClientResponse>;
  /**
   * The size-capped GET of one fixed file of the site.
   *
   * The path must be one of the catalogue paths, one of the extra paths of
   * the site, or a source map that was bound to a discovered script.
   */
  readonly getFixedFile: (path: string) => Promise<ScanClientResponse>;
  /**
   * Binds the source maps that sit next to the given discovered script paths.
   *
   * The binding is explicit and one way: the file check hands over the script
   * paths it found in the pages it actually received, and the capability
   * authorizes the map path next to each of them and nothing else. A map path
   * that was never bound stays refused, whatever it is called, and a path of
   * another host is never bound at all.
   *
   * The bound maps are bounded by the budget of the scan. The returned paths
   * are the ones the capability authorized.
   */
  readonly bindDiscoveredScripts: (scriptPaths: readonly string[]) => readonly string[];
  /**
   * The baseline GET of an authorized parameterized link.
   *
   * The candidate carries the raw URL of the link. It never leaves the
   * process.
   */
  readonly getBaseline: (candidate: ScanCandidate) => Promise<ScanClientResponse>;
  /**
   * The active probe of an authorized parameterized link.
   *
   * The probe URL is the URL of the candidate with a changed value. The client
   * checks it again: only the parameter *names* are authorized, so a probe
   * that adds a parameter or changes the path is refused.
   */
  readonly probeActive: (candidate: ScanCandidate, probeUrl: string) => Promise<ScanClientResponse>;
}

/**
 * The maximum number of source maps one scan may bind.
 *
 * The bound maps are the maps of discovered scripts, so the cap only matters
 * on a site that publishes many scripts.
 */
export const MAX_BOUND_SOURCE_MAPS = 20;

/** Whether a path may be requested as a fixed file of the site. */
function isFixedFilePath(
  scope: ScanScope,
  path: string,
  boundSourceMaps: ReadonlySet<string>,
): boolean {
  if (scope.extraFilePaths.includes(path)) {
    return true;
  }
  if (CATALOGUE_FILE_PATHS.includes(path)) {
    return true;
  }
  // A source map is only allowed when it was bound to a script the scan
  // actually discovered. A suffix alone never authorizes it.
  return boundSourceMaps.has(path);
}

/**
 * Whether a path may be bound as a discovered script.
 *
 * A script is a same-host HTTPS path of a JavaScript file that the scope
 * allows. Nothing else is a script, and nothing else is bound.
 */
function isDiscoveredScriptPath(scope: ScanScope, path: string): boolean {
  if (!path.startsWith('/')) {
    return false;
  }
  if (path.includes('?') || path.includes('#') || path.includes('\\')) {
    return false;
  }
  if (!path.endsWith('.js') && !path.endsWith('.mjs')) {
    return false;
  }
  return evaluateExtraFilePath(scope, path).allowed;
}

/**
 * Creates the request capability of the checks of one scan.
 *
 * The capability is bound to the client of the scan, so a request of a check
 * spends the budget of the scan and obeys the deadline of the scan.
 */
export function createCheckRequester(client: ScanClient, scope: ScanScope): ScanCheckRequester {
  const host = canonicalHostname(scope.hostname);
  const boundSourceMaps = new Set<string>();
  return {
    probeRootPort80: () => client.request({ url: `http://${host}/`, kind: 'transport-probe' }),
    bindDiscoveredScripts: (scriptPaths: readonly string[]): readonly string[] => {
      const authorized: string[] = [];
      for (const scriptPath of scriptPaths) {
        if (authorized.length >= MAX_BOUND_SOURCE_MAPS) {
          break;
        }
        if (authorized.length >= client.remainingRequests) {
          break;
        }
        if (!isDiscoveredScriptPath(scope, scriptPath)) {
          continue;
        }
        const mapPath = `${scriptPath}.map`;
        if (boundSourceMaps.has(mapPath)) {
          continue;
        }
        if (!evaluateExtraFilePath(scope, mapPath).allowed) {
          continue;
        }
        boundSourceMaps.add(mapPath);
        authorized.push(mapPath);
      }
      return authorized;
    },
    getFixedFile: async (path: string) => {
      if (!isFixedFilePath(scope, path, boundSourceMaps)) {
        throw new ScanPolicyError('path_not_allowed', 'The file path is not a fixed file of the site.');
      }
      const decision = evaluateExtraFilePath(scope, path);
      if (!decision.allowed) {
        throw new ScanPolicyError(
          decision.reason ?? 'path_not_allowed',
          'The file path is outside the authorized scope.',
        );
      }
      return await client.request({
        url: `https://${host}${path}`,
        kind: 'explicit',
        authorizedPath: path,
      });
    },
    getBaseline: (candidate: ScanCandidate) =>
      client.request({
        url: candidate.url,
        kind: 'parameterized',
        authorizedPath: candidate.path,
      }),
    probeActive: (candidate: ScanCandidate, probeUrl: string) =>
      client.request({
        url: probeUrl,
        kind: 'active-probe',
        authorizedPath: candidate.path,
      }),
  };
}
