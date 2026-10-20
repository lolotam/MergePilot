// The gated release (ADR-0025): checks → order → image identity → release commit → deploy → verify → rollback.
import {
  type CheckRun,
  type ReleaseKind,
  type ReleaseTrailers,
  evaluateChecks,
  decideRelease,
  hasWorkerPin,
  isReleaseCommit,
  isWebPhaseCommit,
  parseReleaseMessage,
  pinRef,
  readPin,
  readWorkerPin,
  releaseMessage,
  rewritePins,
  sameExceptPins,
  rollbackEligible,
} from './core.ts';
import { type Clock, type ContainerSnapshot, type ExpectedRelease, pollUntil, systemClock, verifyContainers, verifyHealthResponse } from './verify.ts';

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

/**
 * Time kept free in the job beyond the poll timeouts: checkout, registry reads, the hold issue,
 * and the overrun of each of the six polls by at most one attempt (a verify attempt is at most
 * three sequential rounds of requests of REQUEST_TIMEOUT_MS each, so the six overruns stay under
 * 18 minutes).
 */
export const JOB_SETUP_RESERVE_MS = 20 * 60_000;

/**
 * Throws when a release could outlast its job: a release deploys and verifies twice (the web
 * phase and the worker phase), and a failed release does it a third time to roll back. A job
 * cancelled mid-rollback would never open the hold issue.
 */
export function assertFitsJob(cfg: Pick<ReleaseConfig, 'deployTimeoutMs' | 'verifyTimeoutMs'>, jobTimeoutMs: number): void {
  const worst = 3 * (cfg.deployTimeoutMs + cfg.verifyTimeoutMs) + JOB_SETUP_RESERVE_MS;
  if (worst > jobTimeoutMs) {
    throw new Error(`deploy and verify timeouts need up to ${worst / 60_000} min with a rollback; the job allows ${jobTimeoutMs / 60_000} min`);
  }
}

/** What runs in production right now: the web image, the worker image and the release before it. */
interface Deployed {
  /** Commit of the image migrate and web run. */
  sourceSha: string | null;
  /** Image migrate and web run. */
  imageRef: string;
  /** Commit of the image the worker runs. */
  workerSourceSha: string | null;
  /** Image the worker runs; the same as imageRef when the worker has no own pin. */
  workerImageRef: string;
  /** The release before this one, as the record's own previous trailers name it. */
  previousSourceCommit: string | null;
  previousImageRef: string | null;
  previousWorkerSourceCommit: string | null;
  previousWorkerImageRef: string | null;
  /** The head is the web phase of a release: a release stopped between its phases. */
  webPhase: boolean;
  /** Head of the release branch, or null before its first release commit. */
  head: string | null;
}

/** One release as a rollback target: the web image and the worker image of that release. */
interface ReleaseTarget {
  sourceSha: string | null;
  imageRef: string | null;
  workerSourceSha: string | null;
  workerImageRef: string | null;
}

/**
 * The commit the worker image was built from, or null when the record does not know it; then
 * verification checks the worker's image only. A record from before the worker pin already names
 * the web commit here (parseReleaseMessage), so nothing is guessed.
 */
function commitOf(record: { workerSourceSha: string | null }): string | null {
  return record.workerSourceSha;
}

/** The trailers of a release commit: what it releases, what the worker runs, what ran before it. */
function trailersOf(release: { sourceCommit: string; imageRef: string; workerSourceCommit: string | null; workerImageRef: string }, previous: ReleaseTarget): ReleaseTrailers {
  return {
    sourceCommit: release.sourceCommit,
    imageRef: release.imageRef,
    workerSourceCommit: release.workerSourceCommit,
    workerImageRef: release.workerImageRef,
    previousSourceCommit: previous.sourceSha,
    previousImageRef: previous.imageRef,
    previousWorkerSourceCommit: previous.workerSourceSha,
    previousWorkerImageRef: previous.workerImageRef,
  };
}

async function currentDeployment(cfg: ReleaseConfig, gh: GitHubPort): Promise<Deployed | null> {
  const head = await gh.branchHead(cfg.releaseBranch);
  if (head) {
    const trailers = parseReleaseMessage(head.message);
    if (trailers) {
      return {
        sourceSha: trailers.sourceCommit,
        imageRef: trailers.imageRef,
        workerSourceSha: trailers.workerSourceCommit,
        workerImageRef: trailers.workerImageRef,
        previousSourceCommit: trailers.previousSourceCommit,
        previousImageRef: trailers.previousImageRef,
        previousWorkerSourceCommit: trailers.previousWorkerSourceCommit,
        previousWorkerImageRef: trailers.previousWorkerImageRef,
        webPhase: isWebPhaseCommit(head.message),
        head: head.sha,
      };
    }
    return deployedFromCompose(await gh.fileAt(head.sha, cfg.composePath), head.sha);
  }
  if (cfg.live) return null;
  // Dry run before the release branch exists: Dokploy still reads main, so main's pin is what runs.
  return deployedFromCompose(await gh.fileAt('main', cfg.composePath), null);
}

/** The deployed state of a compose file that is not a release commit: its pins. */
function deployedFromCompose(compose: string, head: string | null): Deployed {
  const pin = readPin(compose);
  const workerPin = readWorkerPin(compose);
  return {
    sourceSha: pin.sha,
    imageRef: pin.ref,
    workerSourceSha: workerPin.sha,
    workerImageRef: workerPin.ref,
    previousSourceCommit: null,
    previousImageRef: null,
    previousWorkerSourceCommit: null,
    previousWorkerImageRef: null,
    webPhase: false,
    head,
  };
}

/** Deploys the release branch head and waits until it is verified; returns the problems found. */
async function deployAndVerify(
  ports: ReleasePorts,
  cfg: ReleaseConfig,
  dokploy: DokployPort,
  expected: ExpectedRelease,
  title: string,
): Promise<string[]> {
  const clock = ports.clock ?? systemClock;
  let finished: { id: string; status: string };
  // The release commit is already written, so a refused deploy call must also end in a hold
  // (and a rollback of the record), never in an exception that leaves the record ahead of production.
  try {
    const before = await dokploy.deploymentIds();
    await dokploy.deploy(title, `Source-Commit: ${expected.web.sourceSha}`);
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
  // A web-phase head is a release stopped between its phases: its web phase may never have been
  // deployed or verified, so it is neither a finished release nor a safe rollback target. A person
  // reconciles production; until the hold is closed every release stops at the hold check above.
  if (deployed.webPhase) {
    const short = (deployed.sourceSha ?? 'unknown').slice(0, 7);
    const hold = await gh.openHold(
      `Release hold: ${short} stopped between its phases`,
      [
        `The release branch head is the web phase of \`${deployed.sourceSha ?? 'unknown'}\` (\`${deployed.imageRef}\`), and its worker phase never ran.`,
        `The web phase may not have been deployed or verified; the worker should still run \`${deployed.workerImageRef}\`.`,
        '',
        'Check what production runs, then finish the release or roll it back by hand, and close this hold.',
      ].join('\n'),
    );
    return { kind: 'failed', detail: `release ${short} stopped between its phases`, hold };
  }

  const candidateCompose = await gh.fileAt(sha, cfg.composePath);
  const decision = decideRelease({
    sourceSha: sha,
    deployedSha: deployed.sourceSha,
    onMain: true,
    sourceIsAncestorOfDeployed: deployed.sourceSha !== null && (await gh.isAncestor(sha, deployed.sourceSha)),
    deployedIsAncestorOfSource: deployed.sourceSha !== null && (await gh.isAncestor(deployed.sourceSha, sha)),
  });
  if (decision.kind !== 'deploy') return { kind: decision.kind === 'skip' ? 'skipped' : 'blocked', detail: decision.reason };

  // The compose file of what runs now: the release branch head, or main before the branch exists.
  const deployedCompose = await gh.fileAt(deployed.head ? deployed.head : 'main', cfg.composePath);
  // A compose file without a worker pin is older than the ADR-0025 amendment: it is released in
  // one phase, with every service on the same image.
  const workerPinned = hasWorkerPin(candidateCompose);
  // The web phase takes the candidate's whole compose file and rewrites only the pins, so a
  // change beyond the pins may recreate the worker in that phase too: its drain then keeps the
  // new web from starting, the outage the two phases exist to prevent.
  const pinsOnly = sameExceptPins(candidateCompose, deployedCompose);
  const twoPhases = workerPinned && pinsOnly;

  const repository = readPin(candidateCompose).repository;
  const image = await ports.registry.resolve(repository, sha);
  if (image.revision !== sha) {
    return { kind: 'blocked', detail: `image ${repository}:${sha} has revision ${image.revision ?? 'missing'}, not ${sha}` };
  }
  const imageRef = pinRef(repository, sha, image.digest);

  // The release before this candidate: the rollback target and the "previous" trailers.
  const previous: ReleaseTarget = {
    sourceSha: deployed.sourceSha,
    imageRef: deployed.imageRef,
    workerSourceSha: deployed.workerSourceSha,
    workerImageRef: deployed.workerImageRef,
  };

  // The release commit of one phase: the pinned compose file and the record of the release.
  const commit = (input: { parentSha: string; expectedHead: string | null; content: string; trailers: ReleaseTrailers; kind: ReleaseKind }) =>
    gh.writeReleaseCommit({ branch: cfg.releaseBranch, path: cfg.composePath, parentSha: input.parentSha, content: input.content, message: releaseMessage(input.trailers, input.kind), expectedHead: input.expectedHead });

  if (!twoPhases) {
    if (workerPinned && !pinsOnly) {
      log('plan: the compose file changed beyond the image pins, so this release runs in one phase (the site waits for the worker drain)');
    }
    log(`plan: deploy ${imageRef} (replacing ${deployed.imageRef})`);
    if (!cfg.live) return { kind: 'planned', detail: `would deploy ${imageRef} over ${deployed.imageRef}` };
    if (!ports.dokploy) return { kind: 'blocked', detail: 'live mode needs DOKPLOY_URL, DOKPLOY_API_KEY and DOKPLOY_APP_NAME' };
    const releaseCommit = await commit({
      parentSha: sha,
      expectedHead: deployed.head,
      content: rewritePins(candidateCompose, { image: imageRef, workerImage: imageRef }),
      trailers: trailersOf({ sourceCommit: sha, imageRef, workerSourceCommit: sha, workerImageRef: imageRef }, previous),
      kind: 'release',
    });
    log(`release commit ${releaseCommit} on ${cfg.releaseBranch}`);
    const problems = await deployAndVerify(ports, cfg, ports.dokploy, { web: { imageRef, sourceSha: sha }, worker: { imageRef, sourceSha: sha } }, `release ${sha.slice(0, 7)}`);
    if (problems.length === 0) return { kind: 'deployed', detail: `${imageRef} is running and healthy` };
    return rollBack(cfg, ports, ports.dokploy, { sha, imageRef, workerImageRef: imageRef, workerSourceSha: sha, releaseCommit, problems, previous });
  }

  // Web phase: the new image on migrate and web, the worker on the image it runs today.
  log(`plan: web phase deploys ${imageRef} (replacing ${deployed.imageRef}); the worker stays on ${deployed.workerImageRef}`);
  log(`plan: worker phase deploys ${imageRef} for the worker`);
  if (!cfg.live) {
    return { kind: 'planned', detail: `would deploy ${imageRef} to the web first and then to the worker (the worker stays on ${deployed.workerImageRef} until the second phase)` };
  }
  if (!ports.dokploy) return { kind: 'blocked', detail: 'live mode needs DOKPLOY_URL, DOKPLOY_API_KEY and DOKPLOY_APP_NAME' };

  const webCommit = await commit({
    parentSha: sha,
    expectedHead: deployed.head,
    content: rewritePins(candidateCompose, { image: imageRef, workerImage: deployed.workerImageRef }),
    trailers: trailersOf({ sourceCommit: sha, imageRef, workerSourceCommit: deployed.workerSourceSha, workerImageRef: deployed.workerImageRef }, previous),
    kind: 'web',
  });
  log(`release commit ${webCommit} on ${cfg.releaseBranch} (web phase)`);
  const webProblems = await deployAndVerify(ports, cfg, ports.dokploy, { web: { imageRef, sourceSha: sha }, worker: { imageRef: deployed.workerImageRef, sourceSha: commitOf(deployed) } }, `release ${sha.slice(0, 7)} (web first)`);
  if (webProblems.length > 0) {
    return rollBack(cfg, ports, ports.dokploy, { sha, imageRef, workerImageRef: deployed.workerImageRef, workerSourceSha: deployed.workerSourceSha, releaseCommit: webCommit, problems: webProblems, previous });
  }

  // Worker phase: the new image on the worker too, so only the worker is recreated and drains.
  let workerCommit: string;
  try {
    workerCommit = await commit({
      parentSha: sha,
      expectedHead: webCommit,
      content: rewritePins(candidateCompose, { image: imageRef, workerImage: imageRef }),
      trailers: trailersOf({ sourceCommit: sha, imageRef, workerSourceCommit: sha, workerImageRef: imageRef }, previous),
      kind: 'release',
    });
  } catch (err) {
    // The web phase is deployed and verified, so nothing is rolled back: the record names the
    // web phase, the worker still runs the old image, and a person finishes or rolls back.
    const message = err instanceof Error ? err.message : String(err);
    const hold = await ports.github.openHold(
      `Release hold: ${sha.slice(0, 7)} stopped after the web phase`,
      [
        `The web phase of \`${sha}\` is deployed and verified.`,
        `The worker still runs \`${deployed.workerImageRef}\`.`,
        `The worker-phase release commit could not be written: ${message}`,
        '',
        'A person must finish the release or roll it back by hand.',
      ].join('\n'),
    );
    return { kind: 'failed', detail: `the worker-phase commit could not be written: ${message}`, hold };
  }
  log(`release commit ${workerCommit} on ${cfg.releaseBranch} (worker phase)`);
  const problems = await deployAndVerify(ports, cfg, ports.dokploy, { web: { imageRef, sourceSha: sha }, worker: { imageRef, sourceSha: sha } }, `release ${sha.slice(0, 7)} (worker)`);
  if (problems.length === 0) return { kind: 'deployed', detail: `${imageRef} is running and healthy` };
  return rollBack(cfg, ports, ports.dokploy, { sha, imageRef, workerImageRef: imageRef, workerSourceSha: sha, releaseCommit: workerCommit, problems, previous });
}

interface FailedRelease {
  sha: string;
  imageRef: string;
  /** Image the worker ran in the failed release. */
  workerImageRef: string;
  /** Commit of the worker image in the failed release. */
  workerSourceSha: string | null;
  releaseCommit: string;
  problems: string[];
  /** The release before the candidate: where a rollback returns to. */
  previous: ReleaseTarget;
}

/** Outcome of the rollback attempt: not attempted (with why), or the problems of the rolled-back release. */
type RollbackResult = { attempted: false; reason: string } | { attempted: true; problems: string[] };

async function attemptRollback(cfg: ReleaseConfig, ports: ReleasePorts, dokploy: DokployPort, failed: FailedRelease): Promise<RollbackResult> {
  const { github: gh, log } = ports;
  const previous = failed.previous;
  if (!previous.sourceSha || !previous.imageRef) return { attempted: false, reason: 'the previous release is unknown' };
  const migrations = rollbackEligible(await gh.changedMigrations(previous.sourceSha, failed.sha));
  if (!migrations.eligible) {
    return { attempted: false, reason: `migrations changed (${migrations.migrations.join(', ')}). Decide manually; do not restore the database automatically` };
  }

  const workerImageRef = previous.workerImageRef ?? previous.imageRef;
  let previousCompose: string;
  try {
    previousCompose = rewritePins(await gh.fileAt(previous.sourceSha, cfg.composePath), { image: previous.imageRef, workerImage: workerImageRef });
  } catch (err) {
    // An old compose file without a worker pin cannot bring the worker back on its own image.
    return { attempted: false, reason: `the previous compose file cannot pin the worker separately: ${err instanceof Error ? err.message : String(err)}` };
  }
  const message = releaseMessage(
    trailersOf(
      { sourceCommit: previous.sourceSha, imageRef: previous.imageRef, workerSourceCommit: previous.workerSourceSha, workerImageRef },
      { sourceSha: failed.sha, imageRef: failed.imageRef, workerSourceSha: failed.workerSourceSha, workerImageRef: failed.workerImageRef },
    ),
    'rollback',
  );
  await gh.writeReleaseCommit({ branch: cfg.releaseBranch, parentSha: previous.sourceSha, path: cfg.composePath, content: previousCompose, message, expectedHead: failed.releaseCommit });
  log(`rolling back to ${previous.imageRef}`);
  const problems = await deployAndVerify(
    ports,
    cfg,
    dokploy,
    { web: { imageRef: previous.imageRef, sourceSha: previous.sourceSha }, worker: { imageRef: workerImageRef, sourceSha: commitOf(previous) } },
    `rollback to ${previous.sourceSha.slice(0, 7)}`,
  );
  return { attempted: true, problems };
}

/**
 * Rolls back when it is safe, then always opens the hold issue that stops the next release. A
 * rollback error is written into the hold report instead of escaping; the hold is opened once,
 * outside that error handling, so failing to open it is never mistaken for a rollback error.
 */
async function rollBack(cfg: ReleaseConfig, ports: ReleasePorts, dokploy: DokployPort, failed: FailedRelease): Promise<ReleaseOutcome> {
  const report = [`Release of \`${failed.sha}\` (\`${failed.imageRef}\`) failed verification:`, ...failed.problems.map((p) => `- ${p}`)];
  let result: RollbackResult;
  try {
    result = await attemptRollback(cfg, ports, dokploy, failed);
    if (!result.attempted) report.push('', `Automatic rollback NOT attempted: ${result.reason}.`);
    else if (result.problems.length === 0) report.push('', `Rolled back to \`${failed.previous.imageRef}\`, verified healthy.`);
    else report.push('', ['Rollback ALSO failed verification:', ...result.problems.map((p) => `- ${p}`)].join('\n'));
  } catch (err) {
    result = { attempted: true, problems: [`rollback aborted: ${err instanceof Error ? err.message : String(err)}`] };
    report.push('', `Automatic rollback ABORTED: ${result.problems[0]}. The release branch may still name the failed release; fix it by hand.`);
  }

  const hold = await ports.github.openHold(`Release hold: ${failed.sha.slice(0, 7)} failed verification`, report.join('\n'));
  if (result.attempted && result.problems.length === 0) return { kind: 'rolled-back', detail: failed.problems.join('; '), hold };
  return { kind: 'failed', detail: [...failed.problems, ...(result.attempted ? result.problems : [])].join('; '), hold };
}
