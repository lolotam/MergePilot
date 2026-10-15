// Pure release decisions (ADR-0025). No I/O here: every input is passed in, so each rule is unit-tested.

/** Check runs that must succeed on the same main commit before it may reach production. */
export const IMAGE_CHECK = 'Build and Push Docker Image';
export const REQUIRED_CHECKS = ['check', 'integration', IMAGE_CHECK] as const;

/** Commit subject of a release commit on the release branch. A main commit with it is never released. */
export const RELEASE_SUBJECT_PREFIX = 'chore(release): deploy ';

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export type GateResult =
  | { kind: 'ready' }
  | { kind: 'pending'; waiting: string[] }
  | { kind: 'blocked'; reasons: string[] }
  | { kind: 'no-image'; reason: string };

/**
 * Paths that make `.github/workflows/docker.yml` build an image on a main push. A test keeps this
 * list equal to the workflow's `on.push.paths`.
 */
export const IMAGE_PATHS = [
  'Dockerfile',
  '.dockerignore',
  'docker-compose*.yml',
  'deploy/**',
  '.github/workflows/docker.yml',
  'packages/**',
  'apps/**',
  'package.json',
  'pnpm-lock.yaml',
] as const;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.split('**').map((part) => part.replace(/\*/g, '[^/]*')).join('.*');
  return new RegExp(`^${pattern}$`);
}

const IMAGE_PATH_PATTERNS = IMAGE_PATHS.map(globToRegExp);

/** Whether a change to these files makes the Docker Image workflow build an image. */
export function producesImage(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => IMAGE_PATH_PATTERNS.some((pattern) => pattern.test(file)));
}

/**
 * Decides from the check runs of `sha` whether it may be released. Runs for another commit are
 * ignored, a re-run counts by its latest attempt (highest id), and anything that is not a completed
 * success holds or blocks the release. A missing image check is a skip only when the commit changed
 * no file that builds an image (a docs-only commit); otherwise it is still pending.
 */
export function evaluateChecks(sha: string, runs: readonly CheckRun[], changedFiles: readonly string[]): GateResult {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    if (run.head_sha !== sha) continue;
    const seen = latest.get(run.name);
    if (!seen || run.id > seen.id) latest.set(run.name, run);
  }

  const waiting: string[] = [];
  const reasons: string[] = [];
  for (const name of REQUIRED_CHECKS) {
    const run = latest.get(name);
    if (!run) {
      if (name === IMAGE_CHECK && !producesImage(changedFiles)) continue;
      waiting.push(`${name} (not started)`);
      continue;
    }
    if (run.status !== 'completed') waiting.push(`${name} (${run.status})`);
    else if (run.conclusion !== 'success') reasons.push(`${name} concluded ${run.conclusion ?? 'without a conclusion'}`);
  }

  if (reasons.length > 0) return { kind: 'blocked', reasons };
  if (waiting.length > 0) return { kind: 'pending', waiting };
  if (!latest.has(IMAGE_CHECK)) {
    return { kind: 'no-image', reason: 'no file that builds an image changed, so there is nothing new to deploy' };
  }
  return { kind: 'ready' };
}

export type ReleaseDecision =
  | { kind: 'deploy' }
  | { kind: 'skip'; reason: string }
  | { kind: 'blocked'; reason: string };

/**
 * Orders a candidate against what is deployed, from the two ancestry answers on main. A
 * re-delivered event is idempotent, an older commit never replaces a newer one, and a deployed
 * commit that is not an ancestor (a rollback in place, a rewritten history) needs a person.
 */
export function decideRelease(input: {
  sourceSha: string;
  deployedSha: string | null;
  onMain: boolean;
  /** The candidate is the deployed commit or one of its ancestors. */
  sourceIsAncestorOfDeployed: boolean;
  /** The deployed commit is an ancestor of the candidate. */
  deployedIsAncestorOfSource: boolean;
}): ReleaseDecision {
  const { sourceSha, deployedSha, onMain } = input;
  if (!onMain) return { kind: 'blocked', reason: `${sourceSha} is not on main` };
  if (deployedSha === null) return { kind: 'blocked', reason: 'the deployed commit is unknown; pin one manually first' };
  if (deployedSha === sourceSha) return { kind: 'skip', reason: `${sourceSha} is already deployed` };
  if (input.sourceIsAncestorOfDeployed) {
    return { kind: 'skip', reason: `${sourceSha} is older than the deployed ${deployedSha}` };
  }
  if (!input.deployedIsAncestorOfSource) {
    return { kind: 'blocked', reason: `deployed ${deployedSha} is not an ancestor of ${sourceSha} (rolled back or rewritten)` };
  }
  return { kind: 'deploy' };
}

export interface ImagePin {
  /** The full reference written after `x-image: &image`. */
  ref: string;
  repository: string;
  /** Source commit from a full-SHA tag, or null for any other tag. */
  sha: string | null;
  digest: string | null;
}

const PIN_LINE = /^x-image: &image (\S+)[ \t]*$/m;
const PIN_LINES = /^x-image: &image \S+[ \t]*$/gm;
const REF = /^([a-z0-9./-]+):([A-Za-z0-9_.-]+)(?:@(sha256:[a-f0-9]{64}))?$/;

/** Reads the single release pin of a compose file. */
export function readPin(compose: string): ImagePin {
  const lines = compose.match(PIN_LINES) ?? [];
  if (lines.length !== 1) throw new Error(`expected exactly one "x-image: &image" line, found ${lines.length}`);
  const ref = PIN_LINE.exec(compose)?.[1] ?? '';
  const parts = REF.exec(ref);
  if (!parts) throw new Error(`x-image is not "<repository>:<tag>[@sha256:<digest>]": ${ref}`);
  const [, repository = '', tag = '', digest] = parts;
  return { ref, repository, sha: /^[a-f0-9]{40}$/.test(tag) ? tag : null, digest: digest ?? null };
}

/** The immutable reference a release pins: the full-SHA tag for readers, the digest for the pull. */
export function pinRef(repository: string, sha: string, digest: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`not a full commit SHA: ${sha}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
  return `${repository}:${sha}@${digest}`;
}

/** Returns the compose file with only its release pin replaced. */
export function rewritePin(compose: string, ref: string): string {
  readPin(compose);
  return compose.replace(PIN_LINE, `x-image: &image ${ref}`);
}

export interface ReleaseTrailers {
  sourceCommit: string;
  imageRef: string;
  previousSourceCommit: string | null;
  previousImageRef: string | null;
}

/** Commit message of a release commit. Its trailers are the deployment record read back later. */
export function releaseMessage(t: ReleaseTrailers, rollback: boolean): string {
  const subject = `${RELEASE_SUBJECT_PREFIX}${t.sourceCommit.slice(0, 7)}${rollback ? ' (rollback)' : ''}`;
  return [
    subject,
    '',
    `Source-Commit: ${t.sourceCommit}`,
    `Image-Ref: ${t.imageRef}`,
    `Previous-Source-Commit: ${t.previousSourceCommit ?? 'none'}`,
    `Previous-Image-Ref: ${t.previousImageRef ?? 'none'}`,
  ].join('\n');
}

/** Reads the trailers of a release commit; null when the message is not one. */
export function parseReleaseMessage(message: string): ReleaseTrailers | null {
  if (!message.startsWith(RELEASE_SUBJECT_PREFIX)) return null;
  const field = (key: string): string | null => {
    const value = new RegExp(`^${key}: (\\S+)$`, 'm').exec(message)?.[1] ?? null;
    return value === 'none' ? null : value;
  };
  const sourceCommit = field('Source-Commit');
  const imageRef = field('Image-Ref');
  if (!sourceCommit || !imageRef) return null;
  return { sourceCommit, imageRef, previousSourceCommit: field('Previous-Source-Commit'), previousImageRef: field('Previous-Image-Ref') };
}

/** A main commit that is itself a release commit is never released (loop guard). */
export function isReleaseCommit(message: string): boolean {
  return message.startsWith(RELEASE_SUBJECT_PREFIX);
}

/** Automatic image rollback is safe only when no migration changed between the two releases. */
export function rollbackEligible(changedFiles: readonly string[]): { eligible: boolean; migrations: string[] } {
  const migrations = changedFiles.filter((file) => file.startsWith('apps/app/migrations/'));
  return { eligible: migrations.length === 0, migrations };
}
