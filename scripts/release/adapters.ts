// HTTP adapters for the release ports. Responses can carry secrets (Dokploy returns environment
// values in container configs), so nothing here logs a response body: only the fields it extracts.
import type { CheckRun } from './core.ts';
import type { ContainerSnapshot } from './verify.ts';
import type { DokployPort, GitHubPort, RegistryPort } from './run.ts';

type Fetch = typeof fetch;

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const HOLD_LABEL = 'release-hold';
const MIGRATIONS_DIR = 'apps/app/migrations';

export function githubAdapter(opts: { repository: string; token: string; fetchImpl?: Fetch }): GitHubPort {
  const f = opts.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${opts.repository}`;
  const headers = { authorization: `Bearer ${opts.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const get = <T>(path: string, what: string) => f(`${base}${path}`, { headers }).then((r) => json<T>(r, what));
  const send = <T>(method: string, path: string, body: unknown, what: string) =>
    f(`${base}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r, what));

  type Commit = { commit: { message: string }; files?: { filename: string }[] };
  const commits = new Map<string, Promise<Commit>>();
  const commit = (sha: string) => {
    if (!commits.has(sha)) commits.set(sha, get<Commit>(`/commits/${sha}?per_page=3000`, `commit ${sha}`));
    return commits.get(sha) as Promise<Commit>;
  };
  const branchHead = async (branch: string) => {
    const res = await f(`${base}/branches/${encodeURIComponent(branch)}`, { headers });
    if (res.status === 404) return null;
    const b = await json<{ commit: { sha: string; commit: { message: string } } }>(res, `branch ${branch}`);
    return { sha: b.commit.sha, message: b.commit.commit.message };
  };
  const migrations = async (ref: string) => {
    const res = await f(`${base}/contents/${MIGRATIONS_DIR}?ref=${ref}`, { headers });
    if (res.status === 404) return new Map<string, string>();
    const entries = await json<{ path: string; sha: string }[]>(res, `migrations at ${ref}`);
    return new Map(entries.map((e) => [e.path, e.sha]));
  };

  return {
    commitMessage: async (sha) => (await commit(sha)).commit.message,
    commitFiles: async (sha) => ((await commit(sha)).files ?? []).map((file) => file.filename),
    changedMigrations: async (from, to) => {
      const [a, b] = await Promise.all([migrations(from), migrations(to)]);
      return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
    },
    checkRuns: async (sha) => {
      const runs: CheckRun[] = [];
      for (let page = 1; ; page++) {
        const r = await get<{ total_count: number; check_runs: CheckRun[] }>(`/commits/${sha}/check-runs?per_page=100&page=${page}`, `check runs of ${sha}`);
        runs.push(...r.check_runs);
        if (runs.length >= r.total_count || r.check_runs.length === 0) return runs;
      }
    },
    isAncestor: async (ancestor, descendant) => {
      const c = await get<{ status: string }>(`/compare/${ancestor}...${descendant}`, 'compare');
      return c.status === 'ahead' || c.status === 'identical';
    },
    branchHead,
    fileAt: async (ref, path) => {
      const res = await f(`${base}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers: { ...headers, accept: 'application/vnd.github.raw+json' } });
      if (!res.ok) throw new Error(`${path} at ${ref} answered HTTP ${res.status}`);
      return res.text();
    },
    openHolds: async () =>
      (await get<{ number: number; pull_request?: unknown }[]>(`/issues?labels=${HOLD_LABEL}&state=open`, 'release holds'))
        .filter((i) => !i.pull_request)
        .map((i) => i.number),
    openHold: async (title, body) => (await send<{ number: number }>('POST', '/issues', { title, body, labels: [HOLD_LABEL] }, 'open release hold')).number,
    writeReleaseCommit: async ({ branch, parentSha, path, content, message, expectedHead }) => {
      const parent = await get<{ tree: { sha: string } }>(`/git/commits/${parentSha}`, `commit ${parentSha}`);
      const tree = await send<{ sha: string }>('POST', '/git/trees', { base_tree: parent.tree.sha, tree: [{ path, mode: '100644', type: 'blob', content }] }, 'create tree');
      const created = await send<{ sha: string }>('POST', '/git/commits', { message, tree: tree.sha, parents: [parentSha] }, 'create commit');
      const head = await branchHead(branch);
      if ((head?.sha ?? null) !== expectedHead) {
        throw new Error(`${branch} moved to ${head?.sha ?? 'nothing'} (expected ${expectedHead ?? 'nothing'}); another release ran`);
      }
      if (head) await send('PATCH', `/git/refs/heads/${branch}`, { sha: created.sha, force: true }, `move ${branch}`);
      else await send('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: created.sha }, `create ${branch}`);
      return created.sha;
    },
  };
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Reads a public GHCR image anonymously: the pinned digest and the revision label of its linux/amd64 config. */
export function ghcrAdapter(fetchImpl: Fetch = fetch): RegistryPort {
  return {
    resolve: async (repository, sha) => {
      const name = repository.replace(/^ghcr\.io\//, '');
      const { token } = await json<{ token: string }>(await fetchImpl(`https://ghcr.io/token?scope=repository:${name}:pull`), 'GHCR token');
      const auth = { authorization: `Bearer ${token}` };
      const manifest = (ref: string) => fetchImpl(`https://ghcr.io/v2/${name}/manifests/${ref}`, { headers: { ...auth, accept: MANIFEST_TYPES } });

      const top = await manifest(sha);
      const digest = top.headers.get('docker-content-digest');
      if (!top.ok || !digest) throw new Error(`image ${repository}:${sha} not found (HTTP ${top.status})`);
      let image = (await top.json()) as { manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]; config?: { digest: string } };
      if (image.manifests) {
        const amd64 = image.manifests.find((m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64');
        if (!amd64) throw new Error(`image ${repository}:${sha} has no linux/amd64 manifest`);
        image = await json(await manifest(amd64.digest), 'platform manifest');
      }
      if (!image.config) throw new Error(`image ${repository}:${sha} has no config`);
      const config = await json<{ config?: { Labels?: Record<string, string> } }>(
        await fetchImpl(`https://ghcr.io/v2/${name}/blobs/${image.config.digest}`, { headers: auth }),
        'image config',
      );
      return { digest, revision: config.config?.Labels?.['org.opencontainers.image.revision'] ?? null };
    },
  };
}

interface DockerConfig {
  State?: { Status?: string; ExitCode?: number; Health?: { Status?: string } };
  Config?: { Image?: string; Healthcheck?: unknown; Labels?: Record<string, string> };
}

/** Container snapshot from `docker inspect` output, without the environment it also contains. */
export function snapshotOf(config: DockerConfig): ContainerSnapshot | null {
  const labels = config.Config?.Labels ?? {};
  const service = labels['com.docker.compose.service'];
  if (!service) return null;
  return {
    service,
    image: config.Config?.Image ?? '',
    revision: labels['org.opencontainers.image.revision'] ?? null,
    state: config.State?.Status ?? 'unknown',
    exitCode: config.State?.ExitCode ?? -1,
    health: config.Config?.Healthcheck ? (config.State?.Health?.Status ?? null) : null,
  };
}

/** Dokploy v0.30 REST API for one compose service (`x-api-key` auth). */
export function dokployAdapter(opts: { url: string; apiKey: string; composeId: string; appName: string; fetchImpl?: Fetch }): DokployPort {
  const f = opts.fetchImpl ?? fetch;
  const api = opts.url.replace(/\/+$/, '');
  const headers = { 'x-api-key': opts.apiKey, accept: 'application/json' };
  const get = <T>(path: string, what: string) => f(`${api}${path}`, { headers }).then((r) => json<T>(r, what));
  const deployments = () => get<{ deploymentId: string; status: string }[]>(`/deployment.allByCompose?composeId=${encodeURIComponent(opts.composeId)}`, 'Dokploy deployments');

  return {
    deploymentIds: async () => new Set((await deployments()).map((d) => d.deploymentId)),
    deploy: async (title, description) => {
      const res = await f(`${api}/compose.deploy`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ composeId: opts.composeId, title, description }),
      });
      if (!res.ok) throw new Error(`Dokploy compose.deploy answered HTTP ${res.status}`);
    },
    newDeployment: async (before) => {
      const d = (await deployments()).find((x) => !before.has(x.deploymentId));
      return d ? { id: d.deploymentId, status: d.status } : undefined;
    },
    containers: async () => {
      const list = await get<{ containerId: string }[]>(`/docker.getContainersByAppNameMatch?appName=${encodeURIComponent(opts.appName)}&appType=docker-compose`, 'Dokploy containers');
      const configs = await Promise.all(list.map((c) => get<DockerConfig>(`/docker.getConfig?containerId=${encodeURIComponent(c.containerId)}`, 'container config')));
      return configs.map(snapshotOf).filter((s): s is ContainerSnapshot => s !== null);
    },
  };
}
