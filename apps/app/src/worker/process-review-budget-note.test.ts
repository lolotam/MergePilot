import { describe, expect, it } from 'vitest';
import type { GitHubIssueComment } from '@mergepilot/github';
import type { ReviewCommandJob } from '../core/types.js';
import { HEAD, panelSetup, PUBLISHER, type PanelSetupOptions } from './panel.fixtures.js';
import { processReviewCommandJob } from './process-review-command.js';
import { processReviewJob } from './process-review.js';

// eyadex#78: every bot skipped a huge PR for its budget, the consensus panel published nothing, and
// the owner never learned why. Now one plain-words note says so on the PR, once per head.

/** A repo file whose token limit every bot's prompt exceeds. */
const TINY_TOKEN_LIMIT = { '.mergepilot.yml': 'budget:\n  maxInputTokens: 10\n' };
const MARKER = `<!-- mergepilot:budget-skip head=${HEAD} -->`;

async function setup(options: PanelSetupOptions) {
  const h = await panelSetup({ bots: [{ slot: 2, name: 'Owl' }, { slot: 3, name: 'Fox' }], ...options });
  const issueComments: GitHubIssueComment[] = [];
  h.client.listIssueCommentsPage = async () => issueComments;
  h.client.createIssueComment = async ({ body }) => {
    issueComments.push({ id: issueComments.length + 1, body, user: { login: PUBLISHER } });
    return { id: issueComments.length };
  };
  return { ...h, issueComments };
}

describe('processReviewJob — every bot skipped for its budget', () => {
  it('consensus: posts one note with the reason in plain words, and none again for the same head', async () => {
    const h = await setup({ settings: { panelMode: 'consensus' }, repoFiles: TINY_TOKEN_LIMIT });

    const result = await processReviewJob(h.job, h.deps);
    await processReviewJob({ ...h.job, deliveryId: 'del-panel-again' }, h.deps);

    expect(result).toMatchObject({ status: 'skipped', skippedForBudget: true });
    expect(h.created).toHaveLength(0);
    expect(h.calledModels).toEqual([]);
    expect(h.issueComments).toHaveLength(1);
    const body = h.issueComments[0]?.body ?? '';
    expect(body).toContain('MergePilot skipped this review of `sha-pan`: the PR is too large');
    expect(body).toContain('the limit is 10. Split the PR into smaller ones, or raise `budget.maxInputTokens`');
    expect(body).toContain(MARKER);
    expect(h.events('review.budget_skip_note')).toHaveLength(1);
  });

  it('separate mode: posts the same single note next to the bots\' skipped reviews', async () => {
    const h = await setup({ repoFiles: TINY_TOKEN_LIMIT });

    await processReviewJob(h.job, h.deps);

    expect(h.created).toHaveLength(3);
    expect(h.issueComments).toHaveLength(1);
    expect(h.issueComments[0]?.body).toContain('the PR is too large');
  });

  it('writes the note in Arabic for an Arabic workspace', async () => {
    const h = await setup({ settings: { panelMode: 'consensus', language: 'ar' }, repoFiles: TINY_TOKEN_LIMIT });

    await processReviewJob(h.job, h.deps);

    expect(h.issueComments[0]?.body).toContain('<div dir="rtl">');
    expect(h.issueComments[0]?.body).toContain('الـ PR كبير أوي');
  });

  it('posts no note when at least one bot completed', async () => {
    // Only Owl's model is priced, so high that its review is over the per-review budget.
    const h = await setup({
      settings: { panelMode: 'consensus', priceOverrides: [{ provider: 'openai', model: 'bot2-model', inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 }] },
    });

    await processReviewJob(h.job, h.deps);

    expect((await h.runs()).map((r) => [r.botSlot, r.status])).toEqual([[1, 'completed'], [2, 'skipped'], [3, 'completed']]);
    expect((await h.runs())[1]?.detail).toContain('estimated $');
    expect(h.created).toHaveLength(1);
    expect(h.issueComments).toEqual([]);
  });

  it('logs a note that could not be posted and still finishes the job', async () => {
    const h = await setup({ settings: { panelMode: 'consensus' }, repoFiles: TINY_TOKEN_LIMIT });
    h.client.createIssueComment = async () => {
      throw new Error('GitHub 502 for sk-panel-test-key-0000');
    };

    const result = await processReviewJob(h.job, h.deps);

    expect(result).toMatchObject({ status: 'skipped', skippedForBudget: true });
    expect(h.events('review.budget_skip_note_failed')).toEqual([
      expect.objectContaining({ jobId: h.job.deliveryId, error: 'Error' }),
    ]);
    expect(JSON.stringify(h.events('review.budget_skip_note_failed'))).not.toContain('sk-panel-test-key');
  });

  it('answers an explicit @mergepilot review with the note when the forced review is skipped for budget', async () => {
    const h = await setup({ settings: { panelMode: 'consensus' }, repoFiles: TINY_TOKEN_LIMIT });
    h.client.getCollaboratorPermission = async () => ({ permission: 'write' });
    const command: ReviewCommandJob = {
      kind: 'review_command', deliveryId: 'c-1', installationId: h.job.installationId, repoFullName: h.job.repoFullName,
      pullNumber: h.job.pullNumber, command: 'review', commenterLogin: 'dev', language: 'en',
    };

    expect(await processReviewCommandJob(command, h.deps)).toBe('review_skipped');

    expect(h.issueComments).toHaveLength(1);
    expect(h.issueComments[0]?.body).toContain('the PR is too large');
    expect(h.issueComments[0]?.body).toContain(MARKER);
  });
});
