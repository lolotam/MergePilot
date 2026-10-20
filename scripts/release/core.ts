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
const WORKER_PIN_LINE = /^x-worker-image: &worker-image (\S+)[ \t]*$/m;
const WORKER_PIN_LINES = /^x-worker-image: &worker-image \S+[ \t]*$/gm;
const REF = /^([a-z0-9./-]+):([A-Za-z0-9_.-]+)(?:@(sha256:[a-f0-9]{64}))?$/;

function parseRef(ref: string, what: string): ImagePin {
  const parts = REF.exec(ref);
  if (!parts) throw new Error(`${what} is not "<repository>:<tag>[@sha256:<digest>]": ${ref}`);
  const [, repository = '', tag = '', digest] = parts;
  return { ref, repository, sha: /^[a-f0-9]{40}$/.test(tag) ? tag : null, digest: digest ?? null };
}

/** Reads the single release pin of a compose file. */
export function readPin(compose: string): ImagePin {
  const lines = compose.match(PIN_LINES) ?? [];
  if (lines.length !== 1) throw new Error(`expected exactly one "x-image: &image" line, found ${lines.length}`);
  return parseRef(PIN_LINE.exec(compose)?.[1] ?? '', 'x-image');
}

/**
 * Reads the worker pin of a compose file. A file without one (older than the ADR-0025
 * amendment) runs the worker from the web image, so then the web pin is the worker pin.
 */
export function readWorkerPin(compose: string): ImagePin {
  const lines = compose.match(WORKER_PIN_LINES) ?? [];
  if (lines.length === 0) return readPin(compose);
  if (lines.length > 1) throw new Error(`expected at most one "x-worker-image: &worker-image" line, found ${lines.length}`);
  return parseRef(WORKER_PIN_LINE.exec(compose)?.[1] ?? '', 'x-worker-image');
}

/** Whether the compose file pins the worker apart from the web (ADR-0025 amendment). */
export function hasWorkerPin(compose: string): boolean {
  return (compose.match(WORKER_PIN_LINES) ?? []).length > 0;
}

/** What a pin line becomes when two compose files are compared without their pins. */
const PIN_PLACEHOLDER = 'x-image: &image <pin>';
const WORKER_PIN_PLACEHOLDER = 'x-worker-image: &worker-image <pin>';

/**
 * The lines of a compose file with the release pins replaced by a placeholder, so two files can
 * be compared without their pins. A file without a worker line keeps its own lines.
 */
function linesWithoutPins(compose: string): string[] {
  return compose
    .replace(/\r\n/g, '\n')
    .replace(PIN_LINES, PIN_PLACEHOLDER)
    .replace(WORKER_PIN_LINES, WORKER_PIN_PLACEHOLDER)
    .split('\n');
}

/**
 * Whether two compose files differ only in their release pins. The web phase of a release
 * rewrites the pins of the candidate's whole compose file, so a change beyond the pins may
 * recreate the worker too: its drain then keeps the new web from starting, the outage the two
 * phases exist to prevent (ADR-0025).
 */
export function sameExceptPins(a: string, b: string): boolean {
  const left = linesWithoutPins(a);
  const right = linesWithoutPins(b);
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

/** The immutable reference a release pins: the full-SHA tag for readers, the digest for the pull. */
export function pinRef(repository: string, sha: string, digest: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`not a full commit SHA: ${sha}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
  return `${repository}:${sha}@${digest}`;
}

/**
 * Returns the compose file with its release pins replaced. A file without a worker pin cannot
 * run the worker from another image, so both refs must be the same then.
 */
export function rewritePins(compose: string, pins: { image: string; workerImage: string }): string {
  readPin(compose);
  const workerLines = compose.match(WORKER_PIN_LINES) ?? [];
  if (workerLines.length > 1) throw new Error(`expected at most one "x-worker-image: &worker-image" line, found ${workerLines.length}`);
  const withImage = compose.replace(PIN_LINE, `x-image: &image ${pins.image}`);
  if (workerLines.length === 0) {
    if (pins.workerImage !== pins.image) {
      throw new Error('the compose file has no "x-worker-image: &worker-image" line, so the worker cannot run another image');
    }
    return withImage;
  }
  return withImage.replace(WORKER_PIN_LINE, `x-worker-image: &worker-image ${pins.workerImage}`);
}

export interface ReleaseTrailers {
  sourceCommit: string;
  imageRef: string;
  /** Commit of the worker image; equal to sourceCommit when the worker has no own pin. */
  workerSourceCommit: string | null;
  workerImageRef: string;
  previousSourceCommit: string | null;
  previousImageRef: string | null;
  previousWorkerSourceCommit: string | null;
  previousWorkerImageRef: string | null;
}

/** What a release commit is: the full release, the web phase of it, or a rollback. */
export type ReleaseKind = 'release' | 'web' | 'rollback';

/** Commit message of a release commit. Its trailers are the deployment record read back later. */
export function releaseMessage(t: ReleaseTrailers, kind: ReleaseKind): string {
  const suffix = kind === 'web' ? ' (web first)' : kind === 'rollback' ? ' (rollback)' : '';
  const subject = `${RELEASE_SUBJECT_PREFIX}${t.sourceCommit.slice(0, 7)}${suffix}`;
  return [
    subject,
    '',
    `Source-Commit: ${t.sourceCommit}`,
    `Image-Ref: ${t.imageRef}`,
    `Previous-Source-Commit: ${t.previousSourceCommit ?? 'none'}`,
    `Previous-Image-Ref: ${t.previousImageRef ?? 'none'}`,
    `Worker-Source-Commit: ${t.workerSourceCommit ?? 'none'}`,
    `Worker-Image-Ref: ${t.workerImageRef}`,
    `Previous-Worker-Source-Commit: ${t.previousWorkerSourceCommit ?? 'none'}`,
    `Previous-Worker-Image-Ref: ${t.previousWorkerImageRef ?? 'none'}`,
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
  const previousSourceCommit = field('Previous-Source-Commit');
  const previousImageRef = field('Previous-Image-Ref');
  // A release commit before the worker pin (ADR-0025 amendment) has no worker trailers: the
  // worker then runs the web image, and so did the release before it. A worker trailer that is
  // present keeps its own value, `none` included: an unknown worker commit is not the web's.
  const workerField = (key: string, fallback: string | null): string | null =>
    new RegExp(`^${key}: \\S+$`, 'm').test(message) ? field(key) : fallback;
  return {
    sourceCommit,
    imageRef,
    workerSourceCommit: workerField('Worker-Source-Commit', sourceCommit),
    workerImageRef: field('Worker-Image-Ref') ?? imageRef,
    previousSourceCommit,
    previousImageRef,
    previousWorkerSourceCommit: workerField('Previous-Worker-Source-Commit', previousSourceCommit),
    previousWorkerImageRef: workerField('Previous-Worker-Image-Ref', previousImageRef),
  };
}

/** A main commit that is itself a release commit is never released (loop guard). */
export function isReleaseCommit(message: string): boolean {
  return message.startsWith(RELEASE_SUBJECT_PREFIX);
}

/** Whether a release commit is the web phase of a release: its subject ends in `(web first)`. */
export function isWebPhaseCommit(message: string): boolean {
  const subject = message.split('\n')[0] ?? '';
  return subject.startsWith(RELEASE_SUBJECT_PREFIX) && subject.endsWith(' (web first)');
}

/** Automatic image rollback is safe only when no migration changed between the two releases. */
export function rollbackEligible(changedFiles: readonly string[]): { eligible: boolean; migrations: string[] } {
  const migrations = changedFiles.filter((file) => file.startsWith('apps/app/migrations/'));
  return { eligible: migrations.length === 0, migrations };
}
