import { postPanelFailedNoteOnce } from '@mergepilot/github';
import { MAIN_BOT_SLOT } from '../core/types.js';
import type { PanelContext } from './panel-types.js';
import type { ProcessReviewResult } from './types.js';

/**
 * When every bot that ran failed in a consensus panel, says so once on the PR: the panel publishes
 * nothing then, so the failure would otherwise be silent. The reason lists the distinct bot failures (at most three, the main bot's first),
 * already redacted, and the publisher shortens and neutralizes it again. A failure to publish the
 * merged review is not a reviewer failure and gets no note. Best effort: a failed note
 * is logged and never fails the job.
 */
export async function notePanelFailed(ctx: PanelContext, results: Map<number, ProcessReviewResult>): Promise<void> {
  const all = [...results.values()];
  if (!ctx.panelActive || ctx.mode !== 'consensus' || all.length === 0 || !all.every((r) => r.status === 'failed' && !r.publishFailed)) return;
  const reasons = [results.get(MAIN_BOT_SLOT), ...all].flatMap((r) => (r?.detail?.trim() ? [r.detail.trim()] : []));
  const reason = [...new Set(reasons)].slice(0, 3).join('; ') || 'unknown';
  try {
    const posted = await postPanelFailedNoteOnce(ctx.client, {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.job.pullNumber,
      headSha: ctx.job.headSha,
      attemptId: ctx.job.deliveryId,
      publisherLogin: ctx.publisherLogin,
      language: ctx.settings.language,
      reason,
    });
    if (posted) ctx.logger.info({ event: 'review.panel_failed_note', jobId: ctx.job.deliveryId }, 'Posted the panel-failed note');
  } catch (error) {
    ctx.logger.warn({ event: 'review.panel_failed_note_failed', jobId: ctx.job.deliveryId, error: error instanceof Error ? error.name : 'unknown' },
      'Could not post the panel-failed note');
  }
}
