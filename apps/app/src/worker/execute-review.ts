import {
  redactSecrets,
  runReview,
  type Finding,
  type MergePilotConfig,
  type ReviewModel,
  type ReviewRunResult,
  type Secret,
} from '@mergepilot/engine';
import {
  listPullRequestFiles,
  publishReview,
  renderReviewSummary,
  type FileContent,
  type GitHubClient,
  type PublishReviewResult,
} from '@mergepilot/github';

export interface ExecuteReviewParams {
  client: GitHubClient;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  prTitle: string;
  prBody: string;
  config: MergePilotConfig;
  configHash: string;
  rulesFiles: FileContent[];
  model: ReviewModel;
  knownSecrets?: Secret[] | undefined;
  publisherLogin?: string | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface ExecuteReviewOutcome {
  outcome: 'completed' | 'skipped-budget' | 'failed';
  costUsd?: number | undefined;
  detail?: string | undefined;
  publish: PublishReviewResult;
  reviewUrl?: string | null;
  runResult?: ReviewRunResult | undefined;
  /** Label (`provider:model`) of the model that answered, when the engine reports it. */
  modelUsed?: string | undefined;
  /** Label of the configured model, set only when an explicit fallback took over (ADR-0008). */
  fallbackFrom?: string | undefined;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

export async function executeReview(
  params: ExecuteReviewParams,
): Promise<ExecuteReviewOutcome> {
  const {
    client,
    owner,
    repo,
    pullNumber,
    headSha,
    prTitle,
    prBody,
    config,
    configHash,
    rulesFiles,
    model,
    knownSecrets = [],
    publisherLogin = 'github-actions[bot]',
    log,
  } = params;

  log?.(`Listing files for pull request #${pullNumber}...`);
  const { files: prFiles } = await listPullRequestFiles(client, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  log?.(`Found ${prFiles.length} files in PR diff`);

  log?.('Running review...');
  const reviewResult = await runReview({
    config,
    pr: {
      title: prTitle,
      body: prBody,
    },
    files: prFiles,
    rulesFiles,
    model,
    knownSecrets,
  });
  log?.(`Review completed with status: ${reviewResult.status}`);

  // ADR-0008: when an explicit fallback model answered, the summary names it and says why.
  const disclosure = reviewResult.status === 'skipped-budget' ? undefined : reviewResult;
  const fallbackSummary =
    disclosure?.fallbackFrom && disclosure.fallbackCode
      ? {
          modelLabel: disclosure.modelUsed ?? model.label,
          fallback: { from: disclosure.fallbackFrom, code: disclosure.fallbackCode },
        }
      : {};

  const envVar = PROVIDER_ENV_MAP[config.provider] ?? 'API key';
  let summaryMarkdown: string;
  let inlineFindings: Finding[];
  let outcome: 'completed' | 'skipped-budget' | 'failed';
  let costUsd: number | undefined;
  let detail: string | undefined;

  if (reviewResult.status === 'completed') {
    outcome = 'completed';
    costUsd = reviewResult.costUsd;
    inlineFindings = reviewResult.inline;
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: reviewResult.summary,
      summaryOnly: reviewResult.summaryOnly,
      inlineCount: reviewResult.inline.length,
      complete: reviewResult.complete,
      incompleteReasons: reviewResult.result.incompleteReasons,
      modelLabel: model.label,
      ...fallbackSummary,
      outcome: 'completed',
      ...(reviewResult.costUsd !== undefined ? { costUsd: reviewResult.costUsd } : {}),
      ...(reviewResult.usage?.inputTokens !== undefined
        ? { inputTokens: reviewResult.usage.inputTokens }
        : {}),
      ...(reviewResult.usage?.outputTokens !== undefined
        ? { outputTokens: reviewResult.usage.outputTokens }
        : {}),
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
      outcome: 'skipped-budget',
      reason: reviewResult.reason,
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
      ...fallbackSummary,
      outcome: 'failed',
      reason,
    });
  }

  let capturedHtmlUrl: string | undefined;
  const wrappedClient: GitHubClient = {
    ...client,
    createReview: async (cp) => {
      const res = await client.createReview(cp);
      if (res && 'html_url' in res && typeof (res as { html_url: unknown }).html_url === 'string') {
        capturedHtmlUrl = (res as { html_url: string }).html_url;
      }
      return res;
    },
  };

  log?.(`Publishing review as ${publisherLogin}...`);
  const publish = await publishReview(wrappedClient, {
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
  });
  log?.(`Review publication outcome: ${publish.status}`);

  let reviewUrl: string | null = null;
  if (capturedHtmlUrl) {
    reviewUrl = capturedHtmlUrl;
  } else if ('reviewId' in publish && typeof publish.reviewId === 'number') {
    reviewUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}#pullrequestreview-${publish.reviewId}`;
  }

  return {
    outcome,
    costUsd,
    detail,
    publish,
    reviewUrl,
    runResult: reviewResult,
    ...(disclosure?.modelUsed ? { modelUsed: disclosure.modelUsed } : {}),
    ...(disclosure?.fallbackFrom ? { fallbackFrom: disclosure.fallbackFrom } : {}),
  };
}
