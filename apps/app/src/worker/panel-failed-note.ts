import { postPanelFailedNoteOnce } from '@mergepilot/github';
import { MAIN_BOT_SLOT } from '../core/types.js';
import type { PanelContext } from './panel-types.js';
import type { ProcessReviewResult } from './types.js';

/**
 * When every bot that ran failed in a consensus panel, says so once on the PR: the panel publishes
 * nothing then, so the failure would otherwise be silent. The reason is the main bot's when it ran,
 * already redacted, and the publisher shortens and neutralizes it again. Best effort: a failed note
 * is logged and never fails the job.
 */
export async function notePanelFailed(ctx: PanelContext, results: Map<number, ProcessReviewResult>): Promise<void> {
  const all = [...results.values()];
  if (!ctx.panelActive || ctx.mode !== 'consensus' || all.length === 0 || !all.every((r) => r.status === 'failed')) return;
  const lead = results.get(MAIN_BOT_SLOT) ?? all[0]!;
  try {
    const posted = await postPanelFailedNoteOnce(ctx.client, {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.job.pullNumber,
      headSha: ctx.job.headSha,
      publisherLogin: ctx.publisherLogin,
      language: ctx.settings.language,
      reason: lead.detail ?? '',
    });
    if (posted) ctx.logger.info({ event: 'review.panel_failed_note', jobId: ctx.job.deliveryId }, 'Posted the panel-failed note');
  } catch (error) {
    ctx.logger.warn({ event: 'review.panel_failed_note_failed', jobId: ctx.job.deliveryId, error: error instanceof Error ? error.name : 'unknown' },
      'Could not post the panel-failed note');
  }
}
