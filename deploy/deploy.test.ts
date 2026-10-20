import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(import.meta.dirname, '..');

describe('Task F4: Docker and Deployment Configuration', () => {
  describe('Dockerfile', () => {
    const dockerfilePath = resolve(rootDir, 'Dockerfile');

    it('exists at repository root', () => {
      expect(existsSync(dockerfilePath)).toBe(true);
    });

    it('uses node:22-bookworm-slim and pins the same pnpm as package.json via corepack', () => {
      const content = readFileSync(dockerfilePath, 'utf8');
      const { packageManager } = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { packageManager: string };
      expect(content).toMatch(/FROM\s+node:22-bookworm-slim/);
      expect(content).toMatch(/corepack\s+enable/);
      expect(content).toContain(`corepack prepare ${packageManager} --activate`);
    });

    it('configures build stage with frozen lockfile and pnpm build', () => {
      const content = readFileSync(dockerfilePath, 'utf8');
      expect(content).toMatch(/AS\s+build/i);
      expect(content).toMatch(/pnpm\s+install\s+--frozen-lockfile/);
      expect(content).toMatch(/pnpm\s+build/);
    });

    it('configures runtime stage with non-root node user, production env, expose 3000, and healthcheck', () => {
      const content = readFileSync(dockerfilePath, 'utf8');
      expect(content).toMatch(/USER\s+node/);
      expect(content).toMatch(/NODE_ENV=production/);
      expect(content).toMatch(/EXPOSE\s+3000/);
      expect(content).toMatch(/HEALTHCHECK/);
      expect(content).toMatch(/\/health/);
    });

    it('defaults to web server command', () => {
      const content = readFileSync(dockerfilePath, 'utf8');
      expect(content).toMatch(/CMD\s+\[.*"dist\/server\/main\.js".*\]/);
    });
  });

  describe('.dockerignore', () => {
    const dockerignorePath = resolve(rootDir, '.dockerignore');

    it('exists at repository root', () => {
      expect(existsSync(dockerignorePath)).toBe(true);
    });

    it('ignores node_modules, dist, .git, and environment secrets', () => {
      const content = readFileSync(dockerignorePath, 'utf8');
      expect(content).toMatch(/node_modules/);
      expect(content).toMatch(/dist/);
      expect(content).toMatch(/\.git/);
      expect(content).toMatch(/\.env/);
    });
  });

  describe('Local docker-compose.yml', () => {
    const composePath = resolve(rootDir, 'docker-compose.yml');

    it('exists at repository root', () => {
      expect(existsSync(composePath)).toBe(true);
    });

    it('defines postgres:17-alpine with volume, healthcheck, memory limit and restart policy', () => {
      const content = readFileSync(composePath, 'utf8');
      expect(content).toMatch(/postgres:17-alpine/);
      expect(content).toMatch(/postgres_data/);
      expect(content).toMatch(/pg_isready/);
      expect(content).toMatch(/memory:\s*(?:512M|256M|1G)/);
      expect(content).toMatch(/restart:\s*(?:unless-stopped|always|"no"|on-failure)/);
    });

    it('defines redis:7-alpine with healthcheck, memory limit and restart policy', () => {
      const content = readFileSync(composePath, 'utf8');
      expect(content).toMatch(/redis:7-alpine/);
      expect(content).toMatch(/redis-cli/);
      expect(content).toMatch(/memory:/);
    });

    it('defines migrate one-shot service with migrate-cli.js', () => {
      const content = readFileSync(composePath, 'utf8');
      expect(content).toMatch(/migrate/);
      expect(content).toMatch(/dist\/bootstrap\/migrate-cli\.js/);
    });

    it('defines web service on port 3000 depending on migrate, postgres and redis', () => {
      const content = readFileSync(composePath, 'utf8');
      expect(content).toMatch(/3000:3000/);
      expect(content).toMatch(/service_completed_successfully/);
      expect(content).toMatch(/service_healthy/);
    });

    it('defines worker service with dist/worker/main.js', () => {
      const content = readFileSync(composePath, 'utf8');
      expect(content).toMatch(/dist\/worker\/main\.js/);
    });
  });

  describe('deploy/docker-compose.dokploy.yml', () => {
    const dokployPath = resolve(rootDir, 'deploy', 'docker-compose.dokploy.yml');

    it('exists in deploy directory', () => {
      expect(existsSync(dokployPath)).toBe(true);
    });

    it('does not expose host ports on web', () => {
      const content = readFileSync(dokployPath, 'utf8');
      expect(content).not.toMatch(/"3000:3000"/);
      expect(content).not.toMatch(/'3000:3000'/);
    });

    it('configures Traefik labels for mergepilot.walidmohamed.com with letsencrypt and port 3000', () => {
      const content = readFileSync(dokployPath, 'utf8');
      expect(content).toContain('traefik.http.routers.mergepilot.rule=Host(`mergepilot.walidmohamed.com`)');
      expect(content).toContain('traefik.http.routers.mergepilot.entrypoints=websecure');
      expect(content).toContain('traefik.http.routers.mergepilot.tls.certresolver=letsencrypt');
      expect(content).toContain('traefik.http.services.mergepilot.loadbalancer.server.port=3000');
    });

    it('pins one immutable release for the web and one for the worker, equal on main', () => {
      const content = readFileSync(dokployPath, 'utf8');
      const pins = content.match(/^x-image: &image \S+$/gm) ?? [];
      const workerPins = content.match(/^x-worker-image: &worker-image \S+$/gm) ?? [];
      expect(pins).toHaveLength(1);
      expect(workerPins).toHaveLength(1);
      expect(pins[0]).toMatch(/^x-image: &image ghcr\.io\/lolotam\/mergepilot:[a-f0-9]{40}(@sha256:[a-f0-9]{64})?$/);
      expect(workerPins[0]).toMatch(/^x-worker-image: &worker-image ghcr\.io\/lolotam\/mergepilot:[a-f0-9]{40}(@sha256:[a-f0-9]{64})?$/);
      expect(workerPins[0]?.replace('x-worker-image: &worker-image ', '')).toBe(pins[0]?.replace('x-image: &image ', ''));
      expect(content).not.toMatch(/mergepilot:latest/);
      expect(content).toMatch(/dokploy-network/);
      expect(content).toMatch(/external:\s*true/);
    });

    it('runs migrate and web from the pinned image and the worker from its own pin', () => {
      const content = readFileSync(dokployPath, 'utf8').replace(/\r\n/g, '\n');
      const block = (service: string) => new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\nvolumes:)`).exec(content)?.[1] ?? '';
      for (const service of ['migrate', 'web']) {
        expect(block(service), service).toMatch(/^ {4}image: \*image$/m);
      }
      expect(block('worker')).toMatch(/^ {4}image: \*worker-image$/m);
      expect(content.match(/ghcr\.io\/lolotam\/mergepilot/g)).toHaveLength(2);
    });

    it("gives the worker a stop grace period that defaults to Docker's current 10s", () => {
      const content = readFileSync(dokployPath, 'utf8');
      expect(content).toContain('stop_grace_period: ${WORKER_STOP_GRACE_PERIOD:-10s}');
    });

    it('places postgres and redis on internal network only', () => {
      const content = readFileSync(dokployPath, 'utf8');
      expect(content).toMatch(/internal:\s*true/);
    });
  });

  describe('deploy/.env.example', () => {
    const envExamplePath = resolve(rootDir, 'deploy', '.env.example');

    it('exists in deploy directory', () => {
      expect(existsSync(envExamplePath)).toBe(true);
    });

    it('includes all required core config variables and additions', () => {
      const content = readFileSync(envExamplePath, 'utf8');
      const requiredVars = [
        'MERGEPILOT_BASE_URL',
        'DATABASE_URL',
        'REDIS_URL',
        'MERGEPILOT_MASTER_KEY',
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_WEBHOOK_SECRET',
        'GITHUB_CLIENT_ID',
        'GITHUB_CLIENT_SECRET',
        'GITHUB_APP_SLUG',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'BETTER_AUTH_SECRET',
        'WORKER_CONCURRENCY',
      ];
      for (const v of requiredVars) {
        expect(content).toContain(v);
      }
    });

    it('includes Arabic comments and secret generation command', () => {
      const content = readFileSync(envExamplePath, 'utf8');
      expect(content).toMatch(/[\u0600-\u06FF]/);
      expect(content).toContain("crypto').randomBytes(32).toString('base64')");
    });
  });

  describe('.github/workflows/docker.yml', () => {
    const workflowPath = resolve(rootDir, '.github', 'workflows', 'docker.yml');

    it('exists in .github/workflows directory', () => {
      expect(existsSync(workflowPath)).toBe(true);
    });

    it('triggers on push to main and pull requests touching docker files', () => {
      const content = readFileSync(workflowPath, 'utf8');
      expect(content).toMatch(/push:/);
      expect(content).toMatch(/pull_request:/);
      expect(content).toMatch(/Dockerfile/);
    });

    it('pushes to GHCR lolotam/mergepilot tagged with SHA on main push', () => {
      const content = readFileSync(workflowPath, 'utf8');
      expect(content).toContain('ghcr.io/lolotam/mergepilot');
      expect(content).toMatch(/\$\{\{\s*github\.sha\s*\}\}/);
      expect(content).toMatch(/contents:\s*read/);
      expect(content).toMatch(/packages:\s*write/);
    });
  });

  describe('docs/deploy.ar.md', () => {
    const docPath = resolve(rootDir, 'docs', 'deploy.ar.md');

    it('exists in docs directory and is written in Arabic', () => {
      expect(existsSync(docPath)).toBe(true);
      const content = readFileSync(docPath, 'utf8');
      expect(content).toMatch(/[\u0600-\u06FF]/);
    });

    it('covers all required deployment steps', () => {
      const content = readFileSync(docPath, 'utf8');
      expect(content).toContain('DNS');
      expect(content).toContain('mergepilot.walidmohamed.com');
      expect(content).toContain('Dokploy');
      expect(content).toContain('/health');
      expect(content).toContain('GitHub App');
      expect(content).toMatch(/Postgres|قاعدة البيانات/);
    });
  });
});
