import { describe, expect, it } from 'vitest';
import type { GitHubIssueComment } from '@mergepilot/github';
import { finding, HEAD, panelSetup, PUBLISHER, type PanelSetupOptions } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// A consensus panel whose bots all failed (for example a shared OpenAI 429) publishes nothing, so
// the PR used to stay silent. Now one note per head and review attempt says so.

const ALL_MODELS = ['main-model', 'bot2-model', 'bot3-model'];

async function setup(options: PanelSetupOptions = {}) {
  const h = await panelSetup({ bots: [{ slot: 2 }, { slot: 3 }], settings: { panelMode: 'consensus' }, ...options });
  const issueComments: GitHubIssueComment[] = [];
  h.client.listIssueCommentsPage = async () => issueComments;
  h.client.createIssueComment = async ({ body }) => {
    issueComments.push({ id: issueComments.length + 1, body, user: { login: PUBLISHER } });
    return { id: issueComments.length };
  };
  return { ...h, issueComments };
}

describe('processReviewJob — every bot of a consensus panel failed', () => {
  it('posts one note per review attempt: a webhook redelivery adds none, a retry adds its own', async () => {
    const h = await setup({ failing: ALL_MODELS });

    const result = await processReviewJob(h.job, h.deps);
    await processReviewJob(h.job, h.deps);
    await processReviewJob({ ...h.job, deliveryId: 'del-retry' }, h.deps);

    expect(result.status).toBe('failed');
    expect(h.created).toHaveLength(0);
    expect(h.issueComments).toHaveLength(2);
    expect(h.issueComments[0]?.body).toContain('no reviewer finished');
    expect(h.issueComments[0]?.body).toContain(`<!-- mergepilot:panel-failed head=${HEAD} attempt=del-panel -->`);
    expect(h.issueComments[1]?.body).toContain(`attempt=del-retry -->`);
  });

  it('posts no note when one bot completed', async () => {
    const h = await setup({ failing: ['main-model', 'bot2-model'], findings: { 'bot3-model': [finding('Fox issue')] } });

    await processReviewJob(h.job, h.deps);

    expect(h.created).toHaveLength(1);
    expect(h.issueComments).toEqual([]);
  });

  it('posts no note in separate mode, where each bot reports on its own', async () => {
    const h = await setup({ failing: ALL_MODELS, settings: { panelMode: 'separate' } });

    await processReviewJob(h.job, h.deps);

    expect(h.issueComments).toEqual([]);
  });

  it('posts no note when the bots reviewed and only publishing the merged review failed', async () => {
    const h = await setup();
    h.client.createReview = async () => {
      throw new Error('GitHub 502');
    };

    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('failed');
    expect((await h.runs()).map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(h.issueComments).toEqual([]);
  });
});
