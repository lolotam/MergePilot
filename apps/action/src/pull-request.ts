import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import {
  createReviewModel,
  EnvCredentialStore,
  parseConfig,
  runReview,
  Secret,
  type Finding,
} from '@mergepilot/engine';
import {
  createOctokitClient,
  listPullRequestFiles,
  publishReview,
  readFilesAtRef,
  renderReviewSummary,
} from '@mergepilot/github';
import type { ActionDeps } from './deps.js';


const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

/**
 * Pull-request review: loads .mergepilot.yml and rules files from the base branch, runs the
 * review engine, and publishes one COMMENT review.
 */
export async function runPullRequestReview(deps?: ActionDeps): Promise<void> {
  const env = deps?.env ?? process.env;
  const readFile = deps?.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const createClient = deps?.createClient ?? createOctokitClient;
  const createModel = deps?.createModel ?? createReviewModel;
  const log = deps?.log ?? ((msg: string) => process.stdout.write(msg + '\n'));
  const cwd = deps?.cwd ? deps.cwd() : (env.GITHUB_WORKSPACE ?? process.cwd());

  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request') {
    log(`MergePilot skipped: event "${eventName ?? ''}" is not pull_request`);
    return;
  }

  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set');
  }

  const eventRaw = await readFile(eventPath, 'utf8');
  const payload = JSON.parse(eventRaw) as {
    pull_request?: {
      number: number;
      draft?: boolean;
      title?: string;
      body?: string | null;
      head?: { sha?: string; repo?: { full_name?: string } | null };
      base?: { sha?: string; repo?: { full_name?: string } | null };
    };
  };

  const pr = payload.pull_request;
  if (!pr) {
    throw new Error('Event payload does not contain pull_request');
  }

  if (pr.draft) {
    log('MergePilot skipped: draft PR');
    return;
  }

  const headRepo = pr.head?.repo?.full_name;
  const baseRepo = pr.base?.repo?.full_name;
  if (headRepo && baseRepo && headRepo !== baseRepo) {
    log('skipped: fork PR has no secrets');
    return;
  }

  const repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is not set');
  }
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY format: ${repository}`);
  }

  const githubToken =
    env.GITHUB_TOKEN ||
    env['INPUT_GITHUB-TOKEN'] ||
    env.INPUT_GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN (or input github-token) is not set');
  }

  const baseSha = pr.base?.sha;
  if (!baseSha) {
    throw new Error('Missing pull_request.base.sha');
  }
  const headSha = pr.head?.sha;
  if (!headSha) {
    throw new Error('Missing pull_request.head.sha');
  }

  const client = createClient(githubToken);

  log(`Reading .mergepilot.yml from base ref: ${baseSha}`);
  const configFiles = await readFilesAtRef(client, {
    owner,
    repo,
    ref: baseSha,
    paths: ['.mergepilot.yml'],
  });

  const configFile = configFiles[0];
  if (!configFile) {
    log('MergePilot skipped: .mergepilot.yml not found on base branch (not configured)');
    return;
  }

  const parseResult = parseConfig(configFile.content);
  if (!parseResult.ok) {
    throw new Error(`Invalid .mergepilot.yml:\n${parseResult.errors.join('\n')}`);
  }
  const config = parseResult.config;
  log(`Loaded configuration for provider: ${config.provider}`);

  log(`Reading rules files from base ref: ${baseSha}`);
  const rulesFiles = await readFilesAtRef(client, {
    owner,
    repo,
    ref: baseSha,
    paths: config.review.rulesFiles,
  });

  log(`Listing files for pull request #${pr.number}...`);
  const { files: prFiles } = await listPullRequestFiles(client, {
    owner,
    repo,
    pull_number: pr.number,
  });
  log(`Found ${prFiles.length} files in PR diff`);

  const store = new EnvCredentialStore(env);
  const providerSecret = await store.resolve({ provider: config.provider }, 'review');
  const githubSecret = new Secret(githubToken);
  const model = await createModel(config, store, { cwd });
  log(`Created review model: ${model.label}`);

  log('Running review...');
  const reviewResult = await runReview({
    config,
    pr: {
      title: pr.title ?? '',
      body: pr.body ?? '',
    },
    files: prFiles,
    rulesFiles,
    model,
    knownSecrets: [providerSecret, githubSecret],
  });
  log(`Review completed with status: ${reviewResult.status}`);

  const envVar = PROVIDER_ENV_MAP[config.provider] ?? 'API key';
  let summaryMarkdown: string;
  let inlineFindings: Finding[];

  if (reviewResult.status === 'completed') {
    inlineFindings = reviewResult.inline;
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: reviewResult.summary,
      summaryOnly: reviewResult.summaryOnly,
      inlineCount: reviewResult.inline.length,
      complete: reviewResult.complete,
      incompleteReasons: reviewResult.result.incompleteReasons,
      modelLabel: model.label,
      outcome: 'completed',
      ...(reviewResult.usage?.inputTokens !== undefined
        ? { inputTokens: reviewResult.usage.inputTokens }
        : {}),
      ...(reviewResult.usage?.outputTokens !== undefined
        ? { outputTokens: reviewResult.usage.outputTokens }
        : {}),
    });
  } else if (reviewResult.status === 'skipped-budget') {
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
    // reviewResult.status === 'failed'
    inlineFindings = [];
    let reason: string;
    if (reviewResult.reason === 'INVALID_CREDENTIAL') {
      reason = `Review failed: invalid credential for provider "${config.provider}". Please check the ${envVar} secret.`;
    } else if (reviewResult.reason === 'QUOTA') {
      reason = `Review failed: quota exceeded for provider "${config.provider}". Please check quota and billing for ${envVar}.`;
    } else {
      reason = `Review failed: ${reviewResult.reason}`;
    }
    summaryMarkdown = renderReviewSummary({
      language: config.language,
      summary: '',
      summaryOnly: [],
      inlineCount: 0,
      complete: false,
      incompleteReasons: [reason],
      modelLabel: model.label,
      outcome: 'failed',
      reason,
    });
  }

  const configHash = createHash('sha256')
    .update(configFile.content)
    .digest('hex')
    .slice(0, 12);

  const publisherLogin =
    env['INPUT_PUBLISHER-LOGIN'] ||
    env.INPUT_PUBLISHER_LOGIN ||
    'github-actions[bot]';

  log(`Publishing review as ${publisherLogin}...`);
  const pubResult = await publishReview(client, {
    owner,
    repo,
    pull_number: pr.number,
    expectedHeadSha: headSha,
    summaryMarkdown,
    inline: inlineFindings,
    configHash,
    language: config.language,
    suggestionsAsCode: false,
    publisherLogin,
  });
  log(`Review publication outcome: ${pubResult.status}`);
}
