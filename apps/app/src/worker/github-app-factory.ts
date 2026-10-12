import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { workerLogger } from '../core/logger.js';
import { wrapOctokit, type OctokitLike } from './octokit-client.js';
import type { GitHubAppClientFactory } from './types.js';

// Side-effect free on import (no worker, queue or database connection), so the API can use it.

/** Octokit's own request lines go to the structured logger (debug) instead of plain stdout. */
const octokitLog = {
  // Octokit passes request metadata (method, url, status) as a second argument; keep it, the
  // logger redacts it like any other field.
  debug: (message: string, details?: unknown) => workerLogger.debug({ source: 'octokit', details }, message),
  info: (message: string, details?: unknown) => workerLogger.debug({ source: 'octokit', details }, message),
  warn: (message: string, details?: unknown) => workerLogger.warn({ source: 'octokit', details }, message),
  error: (message: string, details?: unknown) => workerLogger.error({ source: 'octokit', details }, message),
};

export function createGitHubAppFactory(
  config: { appId: string; privateKey: string; appSlug: string },
  appFactory?: () => App,
): GitHubAppClientFactory {
  const app =
    appFactory !== undefined
      ? appFactory()
      : new App({
          appId: config.appId,
          privateKey: config.privateKey,
          // The bare App client has no `.rest` namespace; the review client needs `rest.pulls` etc.
          Octokit: Octokit.defaults({ log: octokitLog }),
          log: octokitLog,
        });

  return async (installationId: number) => {
    const octokit = await app.getInstallationOctokit(installationId);
    return {
      client: wrapOctokit(octokit as unknown as OctokitLike),
      publisherLogin: `${config.appSlug}[bot]`,
    };
  };
}
