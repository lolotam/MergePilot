// Entry point of .github/workflows/release.yml. Mode comes from the MERGEPILOT_AUTO_RELEASE
// repository variable: anything but "enabled" is a dry run that changes nothing.
import { appendFileSync } from 'node:fs';
import { dokployAdapter, ghcrAdapter, githubAdapter } from './adapters.ts';
import { assertFitsJob, exitCodeOf, runRelease } from './run.ts';

const MINUTE = 60_000;

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function minutes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of minutes`);
  return value * MINUTE;
}

async function main(): Promise<number> {
  const live = process.env.MERGEPILOT_AUTO_RELEASE?.trim() === 'enabled';
  const sha = env('RELEASE_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`RELEASE_SHA must be a full commit SHA, got "${sha}"`);
  const repository = env('GITHUB_REPOSITORY');
  const productionUrl = env('PRODUCTION_URL').replace(/\/+$/, '');

  const dokployUrl = process.env.DOKPLOY_URL?.trim();
  const apiKey = process.env.DOKPLOY_API_KEY?.trim();
  const composeId = process.env.DOKPLOY_COMPOSE_ID?.trim();
  const appName = process.env.DOKPLOY_APP_NAME?.trim();
  const dokploy = dokployUrl && apiKey && composeId && appName ? dokployAdapter({ url: dokployUrl, apiKey, composeId, appName }) : null;

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  log(`mode: ${live ? 'LIVE' : 'dry run (set MERGEPILOT_AUTO_RELEASE=enabled to deploy)'}; candidate ${sha}`);

  const cfg = {
    sha,
    live,
    repository,
    releaseBranch: env('RELEASE_BRANCH', 'production'),
    composePath: env('COMPOSE_PATH', 'deploy/docker-compose.dokploy.yml'),
    deployTimeoutMs: minutes('DEPLOY_TIMEOUT_MINUTES', 35),
    verifyTimeoutMs: minutes('VERIFY_TIMEOUT_MINUTES', 10),
    intervalMs: 15_000,
  };
  assertFitsJob(cfg, minutes('JOB_TIMEOUT_MINUTES', 120));

  const outcome = await runRelease(
    cfg,
    {
      github: githubAdapter({ repository, token: env('GITHUB_TOKEN') }),
      registry: ghcrAdapter(),
      dokploy,
      health: async () => {
        const res = await fetch(`${productionUrl}/health`, { headers: { 'cache-control': 'no-cache' } });
        return { status: res.status, body: await res.text() };
      },
      log,
    },
  );
  log(`outcome: ${outcome.kind}: ${outcome.detail}${'hold' in outcome ? ` (release hold #${outcome.hold})` : ''}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `## Release ${sha.slice(0, 7)}: ${outcome.kind}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
  return exitCodeOf(outcome);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`release error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
