import { describe, expect, it } from 'vitest';
import { finding, HEAD, panelSetup, PUBLISHER } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

const settings = { panelMode: 'consensus' as const, panelMinAgreement: 2, minSeverity: 'medium' as const };
const bots = [{ slot: 2, name: 'Owl' }];

describe('consensus rejected copies — PR189 regressions', () => {
  it.each([
    { severity: 'low', minSeverity: 'medium' as const, repoMinSeverity: 'low' },
    { severity: 'info', minSeverity: undefined, repoMinSeverity: 'medium' },
  ])('never revives a rejected $severity claim below the effective bot severity', async ({ severity, minSeverity, repoMinSeverity }) => {
    const h = await panelSetup({
      settings: { ...settings, minSeverity }, bots,
      repoFiles: { '.mergepilot.yml': `review:\n  minSeverity: ${repoMinSeverity}\n` },
      findings: { 'main-model': [finding('Excluded claim', severity)], 'bot2-model': [finding('Excluded claim', severity)] },
      rejectedModels: ['main-model', 'bot2-model'],
    });
    await processReviewJob(h.job, h.deps);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.comments).toHaveLength(0);
    expect(h.created[0]!.body).toContain('<summary>Rejected by verification (2)</summary>');
    expect(h.created[0]!.body).not.toContain('Published although the verifier rejected them');
    expect(h.created[0]!.body).not.toContain('contributed to agreement');
  });

  it('does not count a below-threshold rejected copy as a vote for a kept claim', async () => {
    const h = await panelSetup({
      settings, bots, findings: { 'main-model': [finding('Shared claim')], 'bot2-model': [finding('Shared claim', 'low')] },
      rejectedModels: ['bot2-model'],
    });
    await processReviewJob(h.job, h.deps);
    expect(h.created[0]!.comments).toHaveLength(0);
    expect(h.created[0]!.body).toContain('Shared claim · _Found by: MergePilot (1/2)_');
    expect(h.created[0]!.body).toContain('<summary>Below agreement (1)</summary>');
    expect(h.created[0]!.body).toContain('<summary>Rejected by verification (1)</summary>');
  });

  it('keeps revived incremental LEFT and unreviewed-path findings outside the diff', async () => {
    const previous = await panelSetup({ settings, bots });
    await processReviewJob(previous.job, previous.deps);
    const oldHead = 'a'.repeat(40);
    const rejected = [
      { ...finding('Previous-head deletion', 'medium', 1), side: 'LEFT' },
      { ...finding('Earlier PR file'), path: 'src/earlier.ts' },
      finding('Safe current anchor'),
    ];
    const h = await panelSetup({
      settings, bots, findings: { 'main-model': rejected, 'bot2-model': rejected }, rejectedModels: ['main-model', 'bot2-model'],
      reviews: [{ id: 1, body: previous.created[0]!.body.replace(HEAD, oldHead), user: { login: PUBLISHER } }],
    });
    const changed = { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1,2 +1,2 @@\n context\n-old\n+new' };
    h.client.listPullRequestFilesPage = async () => [changed, { ...changed, filename: 'src/earlier.ts' }];
    h.client.compareCommits = async ({ head }) => head === HEAD ? { status: 'ahead', totalCommits: 1, files: [changed] } : null;
    await processReviewJob(h.job, h.deps);

    const review = h.created[0]!;
    expect(review.body).toContain('Reviewed 1 new commit');
    expect(review.comments).toHaveLength(1);
    expect(review.comments?.[0]?.body).toContain('Safe current anchor');
    expect(review.comments?.[0]).toMatchObject({ path: 'src/app.ts', line: 2, side: 'RIGHT' });
    const outside = review.body.split('### Findings outside the diff')[1];
    expect(outside).toContain('Previous-head deletion');
    expect(outside).toContain('Earlier PR file');
    for (const run of await h.runs()) expect(run.result).not.toHaveProperty('verifyRejectedFindings');
  });
});
