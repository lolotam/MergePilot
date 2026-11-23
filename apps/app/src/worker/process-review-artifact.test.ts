import { parseMarker } from '@mergepilot/github';
import { expect, it, vi } from 'vitest';
import { HEAD, panelSetup } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

const filename = 'api/openapi.json';

it.each(['single-bot', 'consensus'] as const)('publishes a complete %s review with the artifact disclosure', async (mode) => {
  const setup = await panelSetup(mode === 'consensus' ? { settings: { panelMode: 'consensus' }, bots: [{ slot: 2 }] } : {});
  const listFiles = vi.mocked(setup.client.listPullRequestFilesPage);
  const sourceFiles = await listFiles({ owner: 'acme', repo: 'repo', pull_number: 7, page: 1, per_page: 100 });
  listFiles.mockResolvedValue([...sourceFiles, {
    filename, status: 'modified', additions: 20, deletions: 5, changes: 25,
  }]);

  const result = await processReviewJob(setup.job, setup.deps);

  expect(result.status).toBe('completed');
  expect(setup.created).toHaveLength(1);
  const body = setup.created[0]?.body;
  const marker = parseMarker(body);
  expect(marker?.headSha).toBe(HEAD);
  expect(marker?.status).toBeUndefined();
  expect(body).toContain('Generated files changed but not reviewed (no diff could be built): `api/openapi.json`');
  expect(body).not.toContain('Incomplete review');
  if (mode === 'consensus') {
    expect(setup.events('patches.rebuilt')).toEqual([expect.objectContaining({
      rebuilt: 0, failed: [{ path: filename, reason: 'not returned by the contents API' }],
    })]);
  }
});
