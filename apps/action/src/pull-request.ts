import { createHash } from 'node:crypto';
import {
  mkdtemp as fsMkdtemp,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rm as fsRm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeRunner,
  createReviewModel,
  EnvCredentialStore,
  resolveReviewSecrets,
  Secret,
  type CredentialStore,
  type MergePilotConfig,
  type ReviewModel,
} from '@mergepilot/engine';
import {
  createOctokitClient,
  isPrPaused,
  loadRepoConfig,
  postPauseNoticeOnce,
  reviewPullRequest,
} from '@mergepilot/github';
import { trustedCustomBaseUrl, warnIgnoredBaseUrls } from './custom-base-url.js';
import type { ActionDeps } from './deps.js';
import { actionJudge } from './judge.js';
import {
  createSanitizedWorkspace,
  type SanitizedWorkspace,
} from './sandbox.js';

export interface PullRequestReviewDeps extends Omit<ActionDeps, 'createModel'> {
  createModel?:
    | ((
        config: MergePilotConfig,
        store: CredentialStore,
        opts: { cwd: string; configDir?: string; customBaseUrl?: string | undefined },
      ) => Promise<ReviewModel>)
    | undefined;
  createSanitizedWorkspace?: typeof createSanitizedWorkspace | undefined;
  listFiles?: ((dir: string) => Promise<string[]> | string[]) | undefined;
  mkdtemp?: ((prefix: string) => Promise<string> | string) | undefined;
}

const defaultCreateModel = async (
  config: MergePilotConfig,
  store: CredentialStore,
  opts: { cwd: string; configDir?: string; customBaseUrl?: string | undefined },
): Promise<ReviewModel> => {
  if (config.provider === 'claude-code') {
    const token = await store.resolve({ provider: 'claude-code' }, 'review');
    return new ClaudeCodeRunner({
      token,
      cwd: opts.cwd,
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
      ...(config.model ? { model: config.model } : {}),
    });
  }
  return createReviewModel(config, store, opts);
};

/**
 * Pull-request review: loads .mergepilot.yml and rules files from the base branch, runs the
 * review engine, and publishes one COMMENT review.
 */
export async function runPullRequestReview(deps?: PullRequestReviewDeps): Promise<void> {
  const env = deps?.env ?? process.env;
  const readFile = deps?.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const createClient = deps?.createClient ?? createOctokitClient;
  const createModel = deps?.createModel ?? defaultCreateModel;
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
  const configResult = await loadRepoConfig(client, { owner, repo, baseSha });

  if ('missing' in configResult) {
    log('MergePilot skipped: .mergepilot.yml not found on base branch (not configured)');
    return;
  }

  if ('errors' in configResult) {
    throw new Error(`Invalid .mergepilot.yml:\n${configResult.errors.join('\n')}`);
  }

  const { config, configText, rulesFiles } = configResult;
  log(`Loaded configuration for provider: ${config.provider}`);

  const publisherLogin =
    env['INPUT_PUBLISHER-LOGIN'] ||
    env.INPUT_PUBLISHER_LOGIN ||
    'github-actions[bot]';

  const prLabels =
    (payload.pull_request as { labels?: Array<{ name: string }> }).labels?.map((l) => l.name) ?? [];
  const paused = await isPrPaused(client, {
    owner,
    repo,
    pull_number: pr.number,
    publisherLogin,
    labels: prLabels,
  });

  if (paused) {
    log('MergePilot skipped: automatic reviews are paused on this PR');
    await postPauseNoticeOnce(client, {
      owner,
      repo,
      pull_number: pr.number,
      publisherLogin,
      language: config.language,
    });
    return;
  }

  const store = new EnvCredentialStore(env);
  // The primary key (none for a keyless custom server) plus every configured fallback key, so
  // all of them are redacted from the prompt before any model is called.
  const providerSecrets = await resolveReviewSecrets(config, store);
  const githubSecret = new Secret(githubToken);
  const { judge, secrets: judgeSecrets } = actionJudge(config, env, log);

  let sandbox: SanitizedWorkspace | undefined;
  let tempConfigDir: string | undefined;

  try {
    let effectiveCwd = cwd;
    if (config.provider === 'claude-code') {
      const workspaceDir = env.GITHUB_WORKSPACE ?? cwd;
      const listFilesFn = deps?.listFiles;
      let existingFiles: string[];
      if (listFilesFn) {
        existingFiles = await listFilesFn(workspaceDir);
      } else {
        try {
          existingFiles = await fsReaddir(workspaceDir);
        } catch {
          existingFiles = [];
        }
      }

      if (existingFiles.length === 0) {
        throw new Error(
          `GITHUB_WORKSPACE has no checkout (no files found in "${workspaceDir}"). Please add the "actions/checkout" step to your workflow before running MergePilot.`,
        );
      }

      const createSanitizedWorkspaceFn =
        deps?.createSanitizedWorkspace ?? createSanitizedWorkspace;
      sandbox = await createSanitizedWorkspaceFn({
        sourceDir: workspaceDir,
        ...(listFilesFn ? { listFiles: listFilesFn } : {}),
      });

      const mkdtempFn = deps?.mkdtemp ?? ((prefix: string) => fsMkdtemp(prefix));
      tempConfigDir = await mkdtempFn(join(tmpdir(), 'mergepilot-claude-config-'));

      effectiveCwd = sandbox.dir;
    }

    warnIgnoredBaseUrls(config, log);
    const customBaseUrl = trustedCustomBaseUrl(env);
    const model = await createModel(config, store, {
      cwd: effectiveCwd,
      ...(tempConfigDir ? { configDir: tempConfigDir } : {}),
      ...(customBaseUrl ? { customBaseUrl } : {}),
    });
    log(`Created review model: ${model.label}`);
    for (const skipped of model.skippedFallbacks ?? []) {
      log(`Fallback ${skipped.label} skipped: ${skipped.reason}`);
    }

    const configHash = createHash('sha256')
      .update(configText)
      .digest('hex')
      .slice(0, 12);

    await reviewPullRequest({
      client,
      owner,
      repo,
      pullNumber: pr.number,
      headSha,
      baseSha,
      prTitle: pr.title ?? '',
      prBody: pr.body ?? '',
      config,
      configHash,
      rulesFiles,
      model,
      knownSecrets: [...providerSecrets, ...judgeSecrets, githubSecret],
      publisherLogin,
      log,
      ...(judge ? { judge } : {}),
    });
  } finally {
    if (sandbox) {
      await sandbox.cleanup();
    }
    if (tempConfigDir) {
      await fsRm(tempConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
