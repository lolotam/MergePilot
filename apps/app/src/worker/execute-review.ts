import {
  redactSecrets,
  type Finding,
  type ReviewRunResult,
} from '@mergepilot/engine';
import {
  deduplicateFindings,
  fallbackReasonOf,
  judgeBudgetLeft,
  dedupeJudgeOf,
  judgeSummaryInput,
  NOTHING_NEW_DETAIL,
  withJudgeUsage,
  publishReview,
  renderReviewSummary,
  type BotIdentity,
  type GitHubClient,
  type PublishReviewResult,
  type SemanticDedupeResult,
} from '@mergepilot/github';
import { DEFAULT_PUBLISHER_LOGIN, runBotReview, type BotReviewParams } from './bot-review-run.js';

export interface ExecuteReviewParams extends BotReviewParams {
  /** The reviewer-panel bot shown at the top of the summary (ADR-0017); none for a lone main bot. */
  identity?: BotIdentity | undefined;
}

export interface ExecuteReviewOutcome {
  outcome: 'completed' | 'skipped' | 'skipped-budget' | 'failed';
  costUsd?: number | undefined;
  detail?: string | undefined;
  publish: PublishReviewResult;
  reviewUrl?: string | null;
  runResult?: ReviewRunResult | undefined;
  /** Label (`provider:model`) of the model that answered, when the engine reports it. */
  modelUsed?: string | undefined;
  /** Label of the configured model, set only when an explicit fallback took over (ADR-0008). */
  fallbackFrom?: string | undefined;
  fallbackFromMethod?: 'subscription' | 'api-key' | undefined;
  modelUsedMethod?: 'subscription' | 'api-key' | undefined;
  /** What the Jev semantic duplicate check did, when it ran. */
  judgeSemantic?: SemanticDedupeResult | undefined;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** The review link GitHub returned, or one built from the review id. */
export function reviewUrlOf(
  publish: PublishReviewResult,
  capturedHtmlUrl: string | undefined,
  pr: { owner: string; repo: string; pullNumber: number },
): string | null {
  if (capturedHtmlUrl) return capturedHtmlUrl;
  if ('reviewId' in publish && typeof publish.reviewId === 'number') {
    return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pullNumber}#pullrequestreview-${publish.reviewId}`;
  }
  return null;
}

/** Wraps the client so the `html_url` of the review it creates is kept. */
export function capturingReviewUrl(client: GitHubClient): { client: GitHubClient; url: () => string | undefined } {
  let captured: string | undefined;
  const wrapped: GitHubClient = {
    ...client,
    createReview: async (cp) => {
      const res = await client.createReview(cp);
      if (res && 'html_url' in res && typeof (res as { html_url: unknown }).html_url === 'string') {
        captured = (res as { html_url: string }).html_url;
      }
      return res;
    },
  };
  return { client: wrapped, url: () => captured };
}

/** Reviews one bot's PR head and publishes its review (the main bot, or a bot in separate mode). */
export async function executeReview(
  params: ExecuteReviewParams,
): Promise<ExecuteReviewOutcome> {
  const {
    client,
    owner,
    repo,
    pullNumber,
    headSha,
    config,
    configHash,
    model,
    knownSecrets = [],
    publisherLogin = DEFAULT_PUBLISHER_LOGIN,
    log,
    judge,
    botSlot,
    identity,
  } = params;

  const run = await runBotReview(params);
  if (run.kind === 'nothing-new') {
    return { outcome: 'skipped', detail: NOTHING_NEW_DETAIL, publish: { status: 'skipped-no-changes' } };
  }
  const { reviewResult, scope } = run;
  const shown = identity ? { identity } : {};

  // ADR-0008: when an explicit fallback model answered, the summary names it and says why.
  const disclosure = reviewResult.status === 'skipped-budget' ? undefined : reviewResult;
  const fallback = disclosure ? fallbackReasonOf(disclosure, knownSecrets) : undefined;
  const fallbackSummary = fallback ? { modelLabel: disclosure?.modelUsed ?? model.label, fallback } : {};
  if (fallbackSummary.fallback) {
    const { from, code, detail: why } = fallbackSummary.fallback;
    log?.(`Fallback used: ${from} failed (${code})${why ? `: ${why}` : ''}`);
  }

  const envVar = PROVIDER_ENV_MAP[config.provider] ?? 'API key';
  let summaryMarkdown: string;
  let inlineFindings: Finding[];
  let outcome: 'completed' | 'skipped' | 'skipped-budget' | 'failed';
  let costUsd: number | undefined;
  let detail: string | undefined;
  let judgeSemantic: SemanticDedupeResult | undefined;

  if (reviewResult.status === 'completed') {
    outcome = 'completed';

    let deduplicated = reviewResult.inline;
    if (deduplicated.length > 0) {
      log?.('Checking for duplicate findings against existing comments...');
      const dedupeResult = await deduplicateFindings(client, {
        owner,
        repo,
        pull_number: pullNumber,
        findings: deduplicated,
        publisherLogin,
        judge: dedupeJudgeOf(judge),
        knownSecrets,
        maxUsd: judgeBudgetLeft(config, reviewResult.costUsd, judge),
        ...(botSlot !== undefined ? { botSlot } : {}),
      });
      deduplicated = dedupeResult.kept;
      judgeSemantic = dedupeResult.semantic;
      if (dedupeResult.skipped) {
        log?.('Could not read existing review comments; publishing without duplicate filtering');
      }
      if (deduplicated.length < reviewResult.inline.length) {
        log?.(
          `Dropped ${reviewResult.inline.length - deduplicated.length} duplicate findings (${deduplicated.length} remaining)`,
        );
      }
    }
    inlineFindings = deduplicated;
    const judgeReport = judge?.judge.report();
    const totals = withJudgeUsage(reviewResult.costUsd, reviewResult.usage, judgeReport);
    costUsd = totals.costUsd;

    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: reviewResult.summary,
      summaryOnly: reviewResult.summaryOnly,
      inlineCount: inlineFindings.length,
      complete: reviewResult.complete,
      incompleteReasons: reviewResult.result.incompleteReasons,
      modelLabel: model.label,
      scope,
      ...fallbackSummary,
      outcome: 'completed',
      judge: judgeSummaryInput(judgeReport, reviewResult.judge, judge?.uses),
      verifyRejected: reviewResult.verifyRejected,
      rulesLeftOut: run.rulesLeftOut,
      ...(totals.costUsd !== undefined ? { costUsd: totals.costUsd } : {}),
      ...(totals.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
      ...(totals.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
      ...shown,
    });
  } else if (reviewResult.status === 'skipped-budget') {
    outcome = 'skipped-budget';
    detail = redactSecrets(reviewResult.reason, knownSecrets).text;
    inlineFindings = [];
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: '',
      summaryOnly: [],
      inlineCount: 0,
      complete: false,
      incompleteReasons: [reviewResult.reason],
      modelLabel: model.label,
      scope,
      outcome: 'skipped-budget',
      reason: reviewResult.reason,
      ...shown,
    });
  } else {
    outcome = 'failed';
    inlineFindings = [];
    let reason: string;
    if (reviewResult.reason === 'INVALID_CREDENTIAL') {
      reason = `Review failed: invalid credential for provider "${config.provider}". Please check the ${envVar} secret.`;
    } else if (reviewResult.reason === 'QUOTA') {
      reason = `Review failed: quota exceeded for provider "${config.provider}". Please check quota and billing for ${envVar}.`;
    } else {
      reason = `Review failed: ${reviewResult.reason}`;
    }
    if (reviewResult.detail) {
      log?.(`Provider error detail: ${redactSecrets(reviewResult.detail, knownSecrets).text}`);
      reason += ` — ${reviewResult.detail}`;
    }
    reason = redactSecrets(reason, knownSecrets).text;
    detail = redactSecrets(reviewResult.detail ?? reviewResult.reason, knownSecrets).text;
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: '',
      summaryOnly: [],
      inlineCount: 0,
      complete: false,
      incompleteReasons: [reason],
      modelLabel: model.label,
      scope,
      ...fallbackSummary,
      outcome: 'failed',
      reason,
      ...shown,
    });
  }

  const capture = capturingReviewUrl(client);

  log?.(`Publishing review as ${publisherLogin}...`);
  const publish = await publishReview(capture.client, {
    owner,
    repo,
    pull_number: pullNumber,
    expectedHeadSha: headSha,
    summaryMarkdown,
    inline: inlineFindings,
    configHash,
    language: config.language,
    suggestionsAsCode: false,
    publisherLogin,
    // Partial unless every reviewable file was covered (no failed batch, no file dropped for budget).
    partial: !(outcome === 'completed' && reviewResult.status === 'completed' && reviewResult.complete),
    alreadyDeduplicated: true,
    ...(botSlot !== undefined ? { botSlot } : {}),
    ...(params.force ? { force: true } : {}),
  });
  log?.(`Review publication outcome: ${publish.status}`);

  return {
    outcome,
    costUsd,
    detail,
    publish,
    reviewUrl: reviewUrlOf(publish, capture.url(), { owner, repo, pullNumber }),
    runResult: reviewResult,
    ...(disclosure?.modelUsed ? { modelUsed: disclosure.modelUsed } : {}),
    ...(disclosure?.fallbackFrom ? { fallbackFrom: disclosure.fallbackFrom } : {}),
    ...(disclosure?.fallbackFromMethod ? { fallbackFromMethod: disclosure.fallbackFromMethod } : {}),
    ...(disclosure?.modelUsedMethod ? { modelUsedMethod: disclosure.modelUsedMethod } : {}),
    ...(judgeSemantic ? { judgeSemantic } : {}),
  };
}
