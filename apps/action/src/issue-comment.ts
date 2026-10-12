import { readFile as fsReadFile } from 'node:fs/promises';
import {
  createOctokitClient,
  executePauseCommand,
  parsePauseCommandWithLanguage,
} from '@mergepilot/github';
import type { ActionDeps } from './deps.js';

export async function runIssueComment(deps?: ActionDeps): Promise<void> {
  const env = deps?.env ?? process.env;
  const readFile = deps?.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const createClient = deps?.createClient ?? createOctokitClient;
  const log = deps?.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));

  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== 'issue_comment') {
    log(`MergePilot skipped: event "${eventName ?? ''}" is not issue_comment`);
    return;
  }

  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set');
  }

  const eventRaw = await readFile(eventPath, 'utf8');
  const payload = JSON.parse(eventRaw) as {
    action?: string;
    issue?: {
      number: number;
      pull_request?: unknown;
    };
    comment?: {
      body?: string;
      user?: { login?: string; type?: string };
      author_association?: string;
    };
  };

  if (payload.action !== undefined && payload.action !== 'created') {
    log(`MergePilot skipped: issue_comment action "${payload.action}" is not created`);
    return;
  }

  if (!payload.issue?.pull_request) {
    log('MergePilot skipped: comment is not on a pull request');
    return;
  }

  // Bot comments (MergePilot's own replies included) never run a command.
  const commenter = payload.comment?.user;
  if (!commenter?.login || commenter.type === 'Bot' || commenter.login.endsWith('[bot]')) {
    log('MergePilot skipped: comment was posted by a bot');
    return;
  }

  const parsed = parsePauseCommandWithLanguage(payload.comment?.body);
  if (!parsed) {
    log('MergePilot skipped: comment does not contain @mergepilot pause/resume command');
    return;
  }
  const { command, language } = parsed;

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

  const publisherLogin =
    env['INPUT_PUBLISHER-LOGIN'] ||
    env.INPUT_PUBLISHER_LOGIN ||
    'github-actions[bot]';

  const username = commenter.login;
  const client = createClient(githubToken);

  const result = await executePauseCommand(client, {
    owner,
    repo,
    pull_number: payload.issue.number,
    command,
    username,
    authorAssociation: payload.comment?.author_association,
    publisherLogin,
    language,
  });

  log(`MergePilot pause command "${command}" executed with result: ${result.success ? result.state : result.reason}`);
}
