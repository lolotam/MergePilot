import { isPrPaused, postPauseNoticeOnce, type GitHubClient } from '@mergepilot/github';

export const PAUSED_DETAIL = 'automatic reviews are paused on this PR';

/**
 * True when automatic reviews are paused on the PR (label `mergepilot:paused` or the latest
 * pause/resume state comment). Posts the skip notice once per pause. Runs before any credential
 * is resolved or model is called, so a paused PR costs nothing.
 */
export async function pausedWithNotice(
  client: GitHubClient,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    publisherLogin: string;
    labels: Array<{ name?: string }> | undefined;
    language: 'ar' | 'en';
  },
): Promise<boolean> {
  const { owner, repo, pullNumber, publisherLogin, language } = params;
  const labels = (params.labels ?? []).flatMap((l) => (typeof l.name === 'string' ? [l.name] : []));
  const paused = await isPrPaused(client, { owner, repo, pull_number: pullNumber, publisherLogin, labels });
  if (!paused) return false;
  await postPauseNoticeOnce(client, { owner, repo, pull_number: pullNumber, publisherLogin, language });
  return true;
}
