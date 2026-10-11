import {
  appendFile as fsAppendFile,
  mkdtemp,
  readdir,
  readFile as fsReadFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  createReviewModel,
  EnvCredentialStore,
  parseConfig,
  renderAuditReport,
  runAudit as engineRunAudit,
  Secret,
} from '@mergepilot/engine';
import {
  createOctokitClient,
  readFilesAtRef,
} from '@mergepilot/github';
import type { ActionDeps } from './deps.js';

export interface AuditActionDeps extends ActionDeps {
  listFiles?: (dir: string) => Promise<Array<{ path: string; size: number }>>;
  appendSummary?: (content: string) => Promise<void>;
  currentDate?: () => string;
}

async function defaultWalk(
  dir: string,
  baseDir: string = dir,
): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ path: string; size: number }> = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await defaultWalk(fullPath, baseDir)));
    } else if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');
      results.push({ path: relPath, size: fileStat.size });
    }
  }

  return results;
}

/**
 * Full-repository audit, triggered by `workflow_dispatch` or `schedule` (task D5).
 */
export async function runAudit(deps?: AuditActionDeps): Promise<void> {
  const env = deps?.env ?? process.env;
  const readFile = deps?.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const createClient = deps?.createClient ?? createOctokitClient;
  const createModel = deps?.createModel ?? createReviewModel;
  const log = deps?.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const cwd = deps?.cwd ? deps.cwd() : (env.GITHUB_WORKSPACE ?? process.cwd());

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

  const client = createClient(githubToken);
  const ref = env.GITHUB_SHA ?? 'HEAD';

  log(`Reading .mergepilot.yml from ref: ${ref}`);
  const configFiles = await readFilesAtRef(client, {
    owner,
    repo,
    ref,
    paths: ['.mergepilot.yml'],
  });

  const configFile = configFiles[0];
  if (!configFile) {
    log('MergePilot skipped: .mergepilot.yml not found (not configured)');
    return;
  }

  const parseResult = parseConfig(configFile.content);
  if (!parseResult.ok) {
    throw new Error(`Invalid .mergepilot.yml:\n${parseResult.errors.join('\n')}`);
  }
  const config = parseResult.config;

  if (!config.audit.enabled) {
    log('MergePilot skipped: audit is not enabled in .mergepilot.yml');
    return;
  }

  log(`Reading rules files from ref: ${ref}`);
  const rulesFiles = await readFilesAtRef(client, {
    owner,
    repo,
    ref,
    paths: config.review.rulesFiles,
  });

  log(`Listing files in workspace: ${cwd}`);
  const listFiles = deps?.listFiles ?? defaultWalk;
  const files = await listFiles(cwd);
  log(`Found ${files.length} candidate files`);

  const store = new EnvCredentialStore(env);
  const providerSecret = await store.resolve({ provider: config.provider }, 'review');
  const githubSecret = new Secret(githubToken);
  // The audit sends file contents in the prompt itself, so in subscription mode the CLI gets an
  // EMPTY working directory and an isolated config dir: nothing in the repository (CLAUDE.md,
  // .claude/ hooks, .mcp.json) can instruct it.
  const isolated: string[] = [];
  if (config.provider === 'claude-code') {
    isolated.push(await mkdtemp(join(tmpdir(), 'mergepilot-audit-cwd-')));
    isolated.push(await mkdtemp(join(tmpdir(), 'mergepilot-audit-config-')));
  }
  const [isolatedCwd, configDir] = isolated;
  const model = await createModel(config, store, {
    cwd: isolatedCwd ?? cwd,
    ...(configDir ? { configDir } : {}),
  });
  log(`Created audit model: ${model.label}`);

  log('Running repository audit...');
  const result = await engineRunAudit({
    config,
    rulesFiles,
    readFile: async (p: string) => readFile(join(cwd, p), 'utf8'),
    files,
    model,
    knownSecrets: [providerSecret, githubSecret],
  }).finally(async () => {
    await Promise.all(isolated.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const report = renderAuditReport({
    language: config.language,
    result,
    modelLabel: model.label,
  });

  log('Writing audit report to step summary...');
  if (deps?.appendSummary) {
    await deps.appendSummary(report);
  } else if (env.GITHUB_STEP_SUMMARY) {
    await fsAppendFile(env.GITHUB_STEP_SUMMARY, `${report}\n`, 'utf8');
  }

  if (config.audit.output === 'issue') {
    const dateStr = deps?.currentDate
      ? deps.currentDate()
      : new Date().toISOString().slice(0, 10);
    const issueTitle = `MergePilot audit — ${dateStr}`;
    log(`Creating GitHub issue: "${issueTitle}"...`);
    if (client.createIssue) {
      await client.createIssue({
        owner,
        repo,
        title: issueTitle,
        body: report,
      });
      log('Created GitHub issue successfully');
    }
  }
}
