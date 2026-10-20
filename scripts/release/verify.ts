// Deployment verification (ADR-0025): what counts as a healthy release, and bounded waiting.

/** One compose container as Dokploy's `docker.getConfig` reports it. */
export interface ContainerSnapshot {
  service: string;
  /** `Config.Image`: the reference the container was created from, as written in the compose file. */
  image: string;
  /** `org.opencontainers.image.revision` label: the commit the image was built from. */
  revision: string | null;
  /** `State.Status`: running, exited, restarting, … */
  state: string;
  exitCode: number;
  /** `State.Health.Status`, or null when the container has no healthcheck. */
  health: string | null;
}

export interface ExpectedRelease {
  /** What migrate and web must run. */
  web: { imageRef: string; sourceSha: string };
  /**
   * What the worker must run; the old image between the two release phases. A null commit means
   * the record does not know it (a worker pin without a full-SHA tag): then only the image is checked.
   */
  worker: { imageRef: string; sourceSha: string | null };
}

const APP_SERVICES = ['web', 'worker'] as const;
const DATA_SERVICES = ['postgres', 'redis'] as const;

/**
 * Lists every reason the snapshot is not the expected release running healthily. Empty means
 * verified. A deploy API answer or "Deployed" log line is never enough on its own: identity is the
 * container's image reference and revision label, and readiness is its health status.
 */
export function verifyContainers(containers: readonly ContainerSnapshot[], expected: ExpectedRelease): string[] {
  const problems: string[] = [];
  const byService = new Map(containers.map((c) => [c.service, c]));
  const identity = (c: ContainerSnapshot, want: { imageRef: string; sourceSha: string | null }) => {
    if (c.image !== want.imageRef) problems.push(`${c.service} runs ${c.image}, expected ${want.imageRef}`);
    if (want.sourceSha !== null && c.revision !== want.sourceSha) {
      problems.push(`${c.service} image revision is ${c.revision ?? 'missing'}, expected ${want.sourceSha}`);
    }
  };

  const migrate = byService.get('migrate');
  if (!migrate) problems.push('migrate container not found');
  else {
    identity(migrate, expected.web);
    if (migrate.state !== 'exited') problems.push(`migrate is ${migrate.state}, expected exited`);
    else if (migrate.exitCode !== 0) problems.push(`migrate exited with code ${migrate.exitCode}`);
  }

  for (const service of [...DATA_SERVICES, ...APP_SERVICES]) {
    const c = byService.get(service);
    if (!c) {
      problems.push(`${service} container not found`);
      continue;
    }
    if (service === 'web') identity(c, expected.web);
    if (service === 'worker') identity(c, expected.worker);
    if (c.state !== 'running') problems.push(`${service} is ${c.state}, expected running`);
    else if (c.health !== 'healthy') problems.push(`${service} health is ${c.health ?? 'unknown'}, expected healthy`);
  }
  return problems;
}

/** Problems with the public health answer; the body must be exactly the app's `{ ok: true }`. */
export function verifyHealthResponse(status: number, body: string): string[] {
  if (status !== 200) return [`GET /health answered ${status}`];
  try {
    const parsed = JSON.parse(body) as { ok?: unknown };
    return parsed.ok === true ? [] : [`GET /health body is not {"ok":true}: ${body.slice(0, 80)}`];
  } catch {
    return [`GET /health body is not JSON: ${body.slice(0, 80)}`];
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Calls `attempt` until it returns a value or the deadline passes. A thrown error counts as "not
 * yet" (the API may be briefly unreachable during a redeploy); the last one is kept for the report.
 */
export async function pollUntil<T>(
  attempt: () => Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs: number; clock?: Clock; label: string },
): Promise<T> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + options.timeoutMs;
  let lastError = '';
  for (;;) {
    try {
      const value = await attempt();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (clock.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for ${options.label}${lastError ? ` (last error: ${lastError})` : ''}`);
    }
    await clock.sleep(options.intervalMs);
  }
}
