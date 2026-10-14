// The gated release (ADR-0025): checks → order → image identity → release commit → deploy → verify → rollback.
import {
  type CheckRun,
  evaluateChecks,
  decideRelease,
  isReleaseCommit,
  parseReleaseMessage,
  pinRef,
  readPin,
  releaseMessage,
  rewritePin,
  rollbackEligible,
} from './core.ts';
import { type Clock, type ContainerSnapshot, pollUntil, systemClock, verifyContainers, verifyHealthResponse } from './verify.ts';

export interface GitHubPort {
  commitMessage(sha: string): Promise<string>;
  /** Files changed by this one commit (against its first parent). */
  commitFiles(sha: string): Promise<string[]>;
  /** Migration files that differ between two commits (added, removed or changed). */
  changedMigrations(base: string, head: string): Promise<string[]>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  /** True when `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  branchHead(branch: string): Promise<{ sha: string; message: string } | null>;
  fileAt(ref: string, path: string): Promise<string>;
  openHolds(): Promise<number[]>;
  openHold(title: string, body: string): Promise<number>;
  /** Commits `content` at `path` on top of `parentSha` and moves `branch` to it if it still points at `expectedHead`. */
  writeReleaseCommit(input: { branch: string; parentSha: string; path: string; content: string; message: string; expectedHead: string | null }): Promise<string>;
}

export interface RegistryPort {
  /** Digest of the pushed `repository:sha` image and its revision label. */
  resolve(repository: string, sha: string): Promise<{ digest: string; revision: string | null }>;
}

export interface DokployPort {
  deploymentIds(): Promise<Set<string>>;
  deploy(title: string, description: string): Promise<void>;
  /** The deployment started after `before`, with its status, once it exists. */
  newDeployment(before: Set<string>): Promise<{ id: string; status: string } | undefined>;
  containers(): Promise<ContainerSnapshot[]>;
}

export interface ReleaseConfig {
  sha: string;
  live: boolean;
  repository: string;
  releaseBranch: string;
  composePath: string;
  deployTimeoutMs: number;
  verifyTimeoutMs: number;
  intervalMs: number;
}

export interface ReleasePorts {
  github: GitHubPort;
  registry: RegistryPort;
  /** Null when no Dokploy credentials are configured; only a dry run may proceed without them. */
  dokploy: DokployPort | null;
  health(): Promise<{ status: number; body: string }>;
  log(line: string): void;
  clock?: Clock;
}

export type ReleaseOutcome =
  | { kind: 'deployed' | 'skipped' | 'waiting' | 'blocked' | 'planned'; detail: string }
  | { kind: 'failed' | 'rolled-back'; detail: string; hold: number };

/** Exit code per outcome: only a failed or rolled-back release fails the job (and alerts). */
export function exitCodeOf(outcome: ReleaseOutcome): number {
  return outcome.kind === 'failed' || outcome.kind === 'rolled-back' ? 1 : 0;
}

/** Time kept free in the job for checkout, registry reads and opening the hold issue. */
export const JOB_SETUP_RESERVE_MS = 10 * 60_000;

/**
 * Throws when a release could outlast its job: a failed release deploys and verifies twice
 * (forward, then rollback), and a job cancelled mid-rollback would never open the hold issue.
 */
export function assertFitsJob(cfg: Pick<ReleaseConfig, 'deployTimeoutMs' | 'verifyTimeoutMs'>, jobTimeoutMs: number): void {
  const worst = 2 * (cfg.deployTimeoutMs + cfg.verifyTimeoutMs) + JOB_SETUP_RESERVE_MS;
  if (worst > jobTimeoutMs) {
    throw new Error(`deploy and verify timeouts need up to ${worst / 60_000} min with a rollback; the job allows ${jobTimeoutMs / 60_000} min`);
  }
}

interface Deployed {
  sourceSha: string | null;
  imageRef: string;
  /** Head of the release branch, or null before its first release commit. */
  head: string | null;
}

async function currentDeployment(cfg: ReleaseConfig, gh: GitHubPort): Promise<Deployed | null> {
  const head = await gh.branchHead(cfg.releaseBranch);
  if (head) {
    const trailers = parseReleaseMessage(head.message);
    if (trailers) return { sourceSha: trailers.sourceCommit, imageRef: trailers.imageRef, head: head.sha };
    const pin = readPin(await gh.fileAt(head.sha, cfg.composePath));
    return { sourceSha: pin.sha, imageRef: pin.ref, head: head.sha };
  }
  if (cfg.live) return null;
  // Dry run before the release branch exists: Dokploy still reads main, so main's pin is what runs.
  const pin = readPin(await gh.fileAt('main', cfg.composePath));
  return { sourceSha: pin.sha, imageRef: pin.ref, head: null };
}

/** Deploys the release branch head and waits until it is verified; returns the problems found. */
async function deployAndVerify(
  ports: ReleasePorts,
  cfg: ReleaseConfig,
  dokploy: DokployPort,
  expected: { imageRef: string; sourceSha: string },
  title: string,
): Promise<string[]> {
  const clock = ports.clock ?? systemClock;
  let finished: { id: string; status: string };
  // The release commit is already written, so a refused deploy call must also end in a hold
  // (and a rollback of the record), never in an exception that leaves the record ahead of production.
  try {
    const before = await dokploy.deploymentIds();
    await dokploy.deploy(title, `Source-Commit: ${expected.sourceSha}`);
    finished = await pollUntil(
      async () => {
        const d = await dokploy.newDeployment(before);
        return d && (d.status === 'done' || d.status === 'error') ? d : undefined;
      },
      { timeoutMs: cfg.deployTimeoutMs, intervalMs: cfg.intervalMs, clock, label: 'the Dokploy deployment to finish' },
    );
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  if (finished.status === 'error') return [`Dokploy deployment ${finished.id} ended in error`];

  let problems: string[] = [];
  try {
    await pollUntil(
      async () => {
        const health = await ports.health();
        problems = [...verifyContainers(await dokploy.containers(), expected), ...verifyHealthResponse(health.status, health.body)];
        return problems.length === 0 ? true : undefined;
      },
      { timeoutMs: cfg.verifyTimeoutMs, intervalMs: cfg.intervalMs, clock, label: 'healthy containers of the new release' },
    );
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err), ...problems];
  }
}

export async function runRelease(cfg: ReleaseConfig, ports: ReleasePorts): Promise<ReleaseOutcome> {
  const { github: gh, log } = ports;
  const sha = cfg.sha;

  if (isReleaseCommit(await gh.commitMessage(sha))) return { kind: 'skipped', detail: `${sha} is a release commit` };
  const holds = await gh.openHolds();
  if (holds.length > 0) return { kind: 'blocked', detail: `release hold open: #${holds.join(', #')}` };
  // Before the checks: a pull request head, a fork or another branch is refused, not left waiting.
  if (!(await gh.isAncestor(sha, 'main'))) return { kind: 'blocked', detail: `${sha} is not on main` };

  const gate = evaluateChecks(sha, await gh.checkRuns(sha), await gh.commitFiles(sha));
  if (gate.kind === 'pending') return { kind: 'waiting', detail: `waiting for ${gate.waiting.join(', ')}` };
  if (gate.kind === 'blocked') return { kind: 'blocked', detail: gate.reasons.join('; ') };
  if (gate.kind === 'no-image') return { kind: 'skipped', detail: gate.reason };

  const deployed = await currentDeployment(cfg, gh);
  if (!deployed) return { kind: 'blocked', detail: `release branch ${cfg.releaseBranch} does not exist; bootstrap it first` };
  const deployedSha = deployed.sourceSha;
  const decision = decideRelease({
    sourceSha: sha,
    deployedSha,
    onMain: true,
    sourceIsAncestorOfDeployed: deployedSha !== null && (await gh.isAncestor(sha, deployedSha)),
    deployedIsAncestorOfSource: deployedSha !== null && (await gh.isAncestor(deployedSha, sha)),
  });
  if (decision.kind !== 'deploy') return { kind: decision.kind === 'skip' ? 'skipped' : 'blocked', detail: decision.reason };

  const repository = readPin(await gh.fileAt(sha, cfg.composePath)).repository;
  const image = await ports.registry.resolve(repository, sha);
  if (image.revision !== sha) {
    return { kind: 'blocked', detail: `image ${repository}:${sha} has revision ${image.revision ?? 'missing'}, not ${sha}` };
  }
  const imageRef = pinRef(repository, sha, image.digest);
  const compose = rewritePin(await gh.fileAt(sha, cfg.composePath), imageRef);
  const message = releaseMessage({ sourceCommit: sha, imageRef, previousSourceCommit: deployedSha, previousImageRef: deployed.imageRef }, false);
  log(`plan: deploy ${imageRef} (replacing ${deployed.imageRef})`);
  if (!cfg.live) return { kind: 'planned', detail: `would deploy ${imageRef} over ${deployed.imageRef}` };
  if (!ports.dokploy) return { kind: 'blocked', detail: 'live mode needs DOKPLOY_URL, DOKPLOY_API_KEY and DOKPLOY_APP_NAME' };

  const releaseCommit = await gh.writeReleaseCommit({ branch: cfg.releaseBranch, parentSha: sha, path: cfg.composePath, content: compose, message, expectedHead: deployed.head });
  log(`release commit ${releaseCommit} on ${cfg.releaseBranch}`);
  const problems = await deployAndVerify(ports, cfg, ports.dokploy, { imageRef, sourceSha: sha }, `release ${sha.slice(0, 7)}`);
  if (problems.length === 0) return { kind: 'deployed', detail: `${imageRef} is running and healthy` };

  return rollBack(cfg, ports, ports.dokploy, { sha, imageRef, releaseCommit, problems, deployed });
}

async function rollBack(
  cfg: ReleaseConfig,
  ports: ReleasePorts,
  dokploy: DokployPort,
  failed: { sha: string; imageRef: string; releaseCommit: string; problems: string[]; deployed: Deployed },
): Promise<ReleaseOutcome> {
  const { github: gh, log } = ports;
  const previousSha = failed.deployed.sourceSha;
  const report = [`Release of \`${failed.sha}\` (\`${failed.imageRef}\`) failed verification:`, ...failed.problems.map((p) => `- ${p}`)];
  const migrations = previousSha ? rollbackEligible(await gh.changedMigrations(previousSha, failed.sha)) : { eligible: false, migrations: [] };

  if (!previousSha || !migrations.eligible) {
    report.push('', previousSha
      ? `Automatic rollback NOT attempted: migrations changed (${migrations.migrations.join(', ')}). Decide manually; do not restore the database automatically.`
      : 'Automatic rollback NOT attempted: the previous release is unknown.');
    const hold = await gh.openHold(`Release hold: ${failed.sha.slice(0, 7)} failed verification`, report.join('\n'));
    return { kind: 'failed', detail: failed.problems.join('; '), hold };
  }

  const previousCompose = rewritePin(await gh.fileAt(previousSha, cfg.composePath), failed.deployed.imageRef);
  const message = releaseMessage({ sourceCommit: previousSha, imageRef: failed.deployed.imageRef, previousSourceCommit: failed.sha, previousImageRef: failed.imageRef }, true);
  await gh.writeReleaseCommit({ branch: cfg.releaseBranch, parentSha: previousSha, path: cfg.composePath, content: previousCompose, message, expectedHead: failed.releaseCommit });
  log(`rolling back to ${failed.deployed.imageRef}`);
  const rollbackProblems = await deployAndVerify(ports, cfg, dokploy, { imageRef: failed.deployed.imageRef, sourceSha: previousSha }, `rollback to ${previousSha.slice(0, 7)}`);
  report.push('', rollbackProblems.length === 0
    ? `Rolled back to \`${failed.deployed.imageRef}\`, verified healthy.`
    : ['Rollback ALSO failed verification:', ...rollbackProblems.map((p) => `- ${p}`)].join('\n'));
  const hold = await gh.openHold(`Release hold: ${failed.sha.slice(0, 7)} failed verification`, report.join('\n'));
  return rollbackProblems.length === 0
    ? { kind: 'rolled-back', detail: failed.problems.join('; '), hold }
    : { kind: 'failed', detail: [...failed.problems, ...rollbackProblems].join('; '), hold };
}
