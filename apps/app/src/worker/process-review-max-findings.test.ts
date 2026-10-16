import { describe, expect, it } from 'vitest';
import { renderFindingComment } from '@mergepilot/github';
import { createHarness } from './model-settings.fixtures.js';
import { finding, panelSetup, PUBLISHER } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// The findings limit (ADR-0033): the workspace setting is the default, a repository file that
// names `review.maxFindings` overrides it, and a consensus panel caps its one merged review.

describe('processReviewJob — findings limit precedence', () => {
  const reviewedLimit = async (settings: { maxFindings?: 5 | 20 | 50 }, repoFiles?: Record<string, string>) => {
    const h = createHarness({ settings, ...(repoFiles ? { repoFiles } : {}) });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');
    return h.getCapturedConfig()?.review.maxFindings;
  };

  it('uses the workspace setting when the repository has no .mergepilot.yml', async () => {
    expect(await reviewedLimit({ maxFindings: 20 })).toBe(20);
  });

  it('uses the workspace setting when the repository file leaves review.maxFindings out', async () => {
    expect(await reviewedLimit({ maxFindings: 50 }, { '.mergepilot.yml': 'review:\n  minSeverity: low\n' })).toBe(50);
  });

  it('lets a repository file that names review.maxFindings override the workspace setting', async () => {
    expect(await reviewedLimit({ maxFindings: 50 }, { '.mergepilot.yml': 'review:\n  maxFindings: 3\n' })).toBe(3);
  });

  it('stays at 5 for a workspace that never chose a limit', async () => {
    expect(await reviewedLimit({})).toBe(5);
    expect(await reviewedLimit({}, { '.mergepilot.yml': 'language: en\n' })).toBe(5);
  });
});

describe('processReviewJob — consensus review respects the findings limit', () => {
  it('publishes at most maxFindings merged findings, most severe and most agreed first, and lists the rest', async () => {
    const h = await panelSetup({
      settings: { panelMode: 'consensus', panelMinAgreement: 1, maxFindings: 5 },
      bots: [{ slot: 2, name: 'Owl' }],
      findings: {
        'main-model': [finding('Alpha'), finding('Bravo'), finding('Charlie'), finding('Delta')],
        'bot2-model': [finding('Alpha'), finding('Echo', 'high'), finding('Foxtrot'), finding('Golf')],
      },
    });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');

    expect(h.created).toHaveLength(1);
    const review = h.created[0]!;
    const titles = review.comments.map((c) => c.body.split('\n')[0]);
    expect(titles).toHaveLength(5);
    expect(titles).toEqual(expect.arrayContaining(['### Echo', '### Alpha']));
    expect(review.body).toContain('<summary>Over the findings limit (2)</summary>');
    expect(review.body).toContain('Foxtrot · _Found by: Owl (1/2)_');
    expect(review.body).toContain('Golf · _Found by: Owl (1/2)_');
    expect(h.events('panel.publish')[0]).toMatchObject({ mode: 'consensus', findings: 5 });
  });

  it('gives no limit slot to a finding the PR already has a comment for', async () => {
    const alpha = finding('Alpha', 'critical');
    const published = { id: 'a', side: 'RIGHT' as const, ...alpha } as Parameters<typeof renderFindingComment>[0];
    const h = await panelSetup({
      settings: { panelMode: 'consensus', panelMinAgreement: 1 },
      repoFiles: { '.mergepilot.yml': 'review:\n  maxFindings: 2\n' },
      bots: [{ slot: 2 }],
      // Each bot keeps its own 2; merged, they are 4 clusters.
      findings: { 'main-model': [alpha, finding('Bravo')], 'bot2-model': [finding('Charlie'), finding('Delta')] },
      comments: [
        { id: 1, path: 'src/app.ts', line: 2, user: { login: PUBLISHER }, body: renderFindingComment(published, { language: 'en', suggestionsAsCode: false }) },
      ],
    });
    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');

    // The top cluster is already on the PR: both slots go to new findings, one is over the limit.
    const titles = h.created[0]!.comments.map((c) => c.body.split('\n')[0]);
    expect(titles).toHaveLength(2);
    expect(titles).not.toContain('### Alpha');
    expect(h.created[0]!.body).toContain('<summary>Over the findings limit (1)</summary>');
    expect(h.created[0]!.body).not.toMatch(/Over the findings limit[\s\S]*Alpha/);
  });

  it('keeps every merged finding when they fit the limit', async () => {
    const h = await panelSetup({
      settings: { panelMode: 'consensus', panelMinAgreement: 1, maxFindings: 10 },
      bots: [{ slot: 2 }],
      findings: { 'main-model': [finding('Alpha'), finding('Bravo')], 'bot2-model': [finding('Charlie')] },
    });
    await processReviewJob(h.job, h.deps);
    expect(h.created[0]?.comments).toHaveLength(3);
    expect(h.created[0]?.body).not.toContain('Over the findings limit');
  });
});
