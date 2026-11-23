import type { Finding } from '@mergepilot/engine';
import type { PanelBotFindings } from './consensus.js';

export function foldFinding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    path: 'src/export.ts',
    line: 10,
    side: 'RIGHT',
    title: 'Expired lease leaves duplicate exports',
    body: 'The scheduler releases expired export leases while active workers still write duplicate archive records.',
    evidence: 'releaseLease(exportJob)',
    suggestion: 'Renew active worker leases before releasing archive export jobs.',
    severity: 'medium',
    category: 'correctness',
    confidence: 0.9,
    ...overrides,
  };
}

export function foldBot(slot: number, ...inline: Finding[]): PanelBotFindings {
  return { slot, name: 'Reviewer ' + slot, inline, summaryOnly: [] };
}

const handbook = 'docs/adr/0042-archive-export-leases.md';

export const distantLineReplay = [
  foldBot(1, foldFinding('export-284', {
    path: handbook, line: 284, severity: 'high',
    title: 'Scheduler can release leases during export',
  })),
  foldBot(2, foldFinding('export-290', {
    path: handbook, line: 290, severity: 'high',
    title: 'Workers cannot retain leases during export',
    body: 'Active workers still write duplicate archive records after the scheduler releases expired export leases.',
  })),
  foldBot(3, foldFinding('export-147', {
    path: handbook, line: 147, severity: 'high',
    title: 'Lease expiry allows duplicate archive writes',
    evidence: handbook + ':290 describes the lease timeout.',
  })),
  foldBot(4, foldFinding('export-251', {
    path: handbook, line: 251,
    title: 'Archive writes survive scheduler lease release',
    body: 'Expired export leases are released by the scheduler while active workers still write duplicate archive records.',
    evidence: handbook + ':290 calls out the active workers.',
  })),
];

const browserPath = 'src/viewer/paging.ts';
const routerPath = 'src/server/route.ts';
const requestPath = 'src/client/request.ts';
const listPath = 'src/viewer/list.tsx';
const pagingFix = 'Include the selected day and cursor in the request and reject stale responses.';

export const linkedFilesReplay = [
  foldBot(1, foldFinding('paging', {
    path: browserPath, line: 48, severity: 'high',
    title: 'Stale cursor overwrites selected day',
    body: 'The archive viewer accepts a delayed page response and replaces the selected day list with stale records.\n\nAlso at: ' + routerPath + ':171',
    suggestion: pagingFix,
  })),
  foldBot(2,
    foldFinding('request', {
      path: requestPath, line: 41,
      title: 'Request accepts stale archive page',
      body: 'A delayed page response contains records for a selected day that no longer matches the cursor.',
      suggestion: pagingFix,
    }),
    foldFinding('list', {
      path: listPath, line: 53,
      title: 'Stale cursor replaces selected day',
      body: 'The archive viewer accepts a delayed page response and overwrites the selected day list with stale records.',
      suggestion: pagingFix,
    }),
  ),
  foldBot(3),
  foldBot(4, foldFinding('route', {
    path: routerPath, line: 161,
    title: 'Stale page records reach archive viewer',
    body: 'The viewer accepts a delayed page response and overwrites the selected day list. Request metadata fails to bind pagination to a stable filter.',
    suggestion: pagingFix,
  })),
];

const alternateAnchor = 'src/queue/retry.ts';

export const alreadyListedReplay = [
  foldBot(1, foldFinding('exporter', {
    severity: 'high',
    body: 'The scheduler releases expired export leases while active workers still write duplicate archive records.\n\nAlso at: ' + alternateAnchor + ':22',
  })),
  foldBot(2, foldFinding('retry', { path: alternateAnchor, line: 22 })),
];
