import { NOTHING_NEW_DETAIL, postNothingNewNoteOnce } from '@mergepilot/github';
import type { PanelContext } from './panel-types.js';
import type { ProcessReviewResult } from './types.js';

/**
 * When every bot that ran skipped this push because nothing changed since its last review (e.g. a
 * merge from the base branch), says so once on the PR: the skip is otherwise silent. Best effort:
 * a failed note is logged and never fails the job.
 */
export async function noteNothingNew(ctx: PanelContext, results: Map<number, ProcessReviewResult>): Promise<void> {
  const all = [...results.values()];
  if (all.length === 0 || !all.every((r) => r.status === 'skipped' && r.detail === NOTHING_NEW_DETAIL)) return;
  try {
    const posted = await postNothingNewNoteOnce(ctx.client, {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.job.pullNumber,
      headSha: ctx.job.headSha,
      publisherLogin: ctx.publisherLogin,
      language: ctx.settings.language,
    });
    if (posted) ctx.logger.info({ event: 'review.nothing_new_note', jobId: ctx.job.deliveryId }, 'Posted the no-new-changes note');
  } catch (error) {
    ctx.logger.warn({ event: 'review.nothing_new_note_failed', jobId: ctx.job.deliveryId, error: error instanceof Error ? error.name : 'unknown' },
      'Could not post the no-new-changes note');
  }
}
