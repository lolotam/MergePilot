import { postBudgetSkipNoteOnce } from '@mergepilot/github';
import { MAIN_BOT_SLOT } from '../core/types.js';
import type { PanelContext } from './panel-types.js';
import type { ProcessReviewResult } from './types.js';

/**
 * When every bot that ran skipped this head because of its budget (the token or per-review cost
 * limit), says so once on the PR with the reason in plain words: a consensus panel publishes
 * nothing then, so the skip is otherwise silent (eyadex#78). The reason is the main bot's when it
 * ran, already redacted. Best effort: a failed note is logged and never fails the job.
 */
export async function noteBudgetSkipped(ctx: PanelContext, results: Map<number, ProcessReviewResult>): Promise<void> {
  const all = [...results.values()];
  if (all.length === 0 || !all.every((r) => r.status === 'skipped' && r.skippedForBudget)) return;
  const lead = results.get(MAIN_BOT_SLOT) ?? all[0]!;
  try {
    const posted = await postBudgetSkipNoteOnce(ctx.client, {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.job.pullNumber,
      headSha: ctx.job.headSha,
      publisherLogin: ctx.publisherLogin,
      language: ctx.settings.language,
      reason: lead.detail ?? '',
    });
    if (posted) ctx.logger.info({ event: 'review.budget_skip_note', jobId: ctx.job.deliveryId }, 'Posted the budget-skip note');
  } catch (error) {
    ctx.logger.warn({ event: 'review.budget_skip_note_failed', jobId: ctx.job.deliveryId, error: error instanceof Error ? error.name : 'unknown' },
      'Could not post the budget-skip note');
  }
}
