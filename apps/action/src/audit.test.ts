import { describe, expect, it, vi } from 'vitest';
import type { ReviewModel } from '@mergepilot/engine';
import type {
  CreateIssueParams,
  GetFileContentParams,
  GitHubClient,
  GitHubCreatedIssue,
} from '@mergepilot/github';
import { runAudit, type AuditActionDeps } from './audit.js';

describe('action runAudit', () => {
  const sha = 'sha-head-000';

  const baseConfigYaml = (enabled = true, output = 'summary', provider = 'anthropic') => `
provider: ${provider}
model: claude-3-5-sonnet
language: en
review:
  maxFindings: 5
  minSeverity: medium
  rulesFiles:
    - CLAUDE.md
audit:
  enabled: ${enabled}
  output: ${output}
`;

  interface SetupOptions {
    auditEnabled?: boolean;
    output?: 'summary' | 'issue';
    filesAtRef?: Record<string, string>;
    workspaceFiles?: Array<{ path: string; size: number }>;
    modelResponseText?: string;
    provider?: 'anthropic' | 'claude-code';
  }

  function setupTest(options: SetupOptions = {}) {
    const auditEnabled = options.auditEnabled ?? true;
    const output = options.output ?? 'summary';

    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const configYaml = baseConfigYaml(auditEnabled, output, options.provider ?? 'anthropic');
    const filesAtRef = options.filesAtRef ?? {
      [`${sha}:.mergepilot.yml`]: configYaml,
      [`${sha}:CLAUDE.md`]: '# Claude guidelines',
    };

    const env: Record<string, string | undefined> = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: 'acme/repo',
      GITHUB_TOKEN: 'sk-gh-token-test-123',
      ANTHROPIC_API_KEY: 'sk-ant-test-key-456',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-789',
      GITHUB_STEP_SUMMARY: '/fake/step_summary.md',
    };

    const createdIssues: CreateIssueParams[] = [];

    const fakeClient: GitHubClient & { createIssue: (params: CreateIssueParams) => Promise<GitHubCreatedIssue> } = {
      async getFileContent(params: GetFileContentParams): Promise<string | null> {
        const key = `${params.ref}:${params.path}`;
        return filesAtRef[key] ?? null;
      },
      async listPullRequestFilesPage() {
        return [];
      },
      async getPullRequest() {
        return { head: { sha } };
      },
      async listReviewsPage() {
        return [];
      },
      async createReview() {
        return { id: 1 };
      },
      async createIssue(params: CreateIssueParams) {
        createdIssues.push(params);
        return { id: 42, number: 10, html_url: 'https://github.com/acme/repo/issues/10' };
      },
    };

    const fakeModel: ReviewModel = {
      label: 'anthropic:claude-3-5-sonnet',
      generate: vi.fn(async () => {
        return {
          text:
            options.modelResponseText ??
            JSON.stringify({
              summary: 'Audit completed cleanly.',
              findings: [],
            }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }),
    };

    const createModel = vi.fn(async () => fakeModel);

    const summariesWritten: string[] = [];
    const appendSummary = vi.fn(async (content: string) => {
      summariesWritten.push(content);
    });

    const fileStore: Record<string, string> = {
      'src/index.ts': 'export const hello = "world";',
    };

    const readFile = vi.fn(async (path: string) => {
      for (const [k, v] of Object.entries(fileStore)) {
        if (path.endsWith(k)) return v;
      }
      return '';
    });

    const listFiles = vi.fn(async () => {
      return (
        options.workspaceFiles ?? [
          { path: 'src/index.ts', size: 30 },
        ]
      );
    });

    const deps: AuditActionDeps = {
      env,
      readFile,
      createClient: () => fakeClient,
      createModel,
      log,
      cwd: () => '/fake/workspace',
      listFiles,
      appendSummary,
      currentDate: () => '2026-10-11',
    };

    return {
      deps,
      logs,
      createModel,
      createdIssues,
      summariesWritten,
    };
  }

  it('skips and does not create model when audit is disabled in config', async () => {
    const { deps, logs, createModel, summariesWritten, createdIssues } = setupTest({
      auditEnabled: false,
    });

    await runAudit(deps);

    expect(createModel).not.toHaveBeenCalled();
    expect(summariesWritten).toHaveLength(0);
    expect(createdIssues).toHaveLength(0);
    expect(logs.some((l) => l.includes('not enabled'))).toBe(true);
  });

  it('runs audit and writes summary when enabled with output: summary', async () => {
    const { deps, createModel, summariesWritten, createdIssues } = setupTest({
      auditEnabled: true,
      output: 'summary',
    });

    await runAudit(deps);

    expect(createModel).toHaveBeenCalled();
    expect(summariesWritten).toHaveLength(1);
    expect(summariesWritten[0]).toContain('## MergePilot repository audit');
    expect(summariesWritten[0]).toContain('Audit completed cleanly.');
    expect(createdIssues).toHaveLength(0);
  });

  it('creates a GitHub issue titled "MergePilot audit — <date>" when output: issue', async () => {
    const { deps, createModel, summariesWritten, createdIssues } = setupTest({
      auditEnabled: true,
      output: 'issue',
    });

    await runAudit(deps);

    expect(createModel).toHaveBeenCalled();
    expect(summariesWritten).toHaveLength(1);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]?.title).toBe('MergePilot audit — 2026-10-11');
    expect(createdIssues[0]?.body).toContain('## MergePilot repository audit');
  });

  it('skips gracefully when .mergepilot.yml is missing', async () => {
    const { deps, logs, createModel } = setupTest({
      filesAtRef: {},
    });

    await runAudit(deps);

    expect(createModel).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('not found'))).toBe(true);
  });

  it('runs claude-code in an empty isolated directory, never the workspace', async () => {
    const { deps, createModel } = setupTest({ provider: 'claude-code' });

    await runAudit(deps);

    const opts = (createModel.mock.calls[0] as unknown[] | undefined)?.[2] as
      | { cwd: string; configDir?: string }
      | undefined;
    expect(opts?.cwd).toBeDefined();
    expect(opts?.cwd).not.toBe('/fake/workspace');
    expect(opts?.configDir).toBeDefined();
  });
});
