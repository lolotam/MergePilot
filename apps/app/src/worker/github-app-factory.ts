import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { wrapOctokit, type OctokitLike } from './octokit-client.js';
import type { GitHubAppClientFactory } from './types.js';

// Side-effect free on import (no worker, queue or database connection), so the API can use it.

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
          Octokit,
        });

  return async (installationId: number) => {
    const octokit = await app.getInstallationOctokit(installationId);
    return {
      client: wrapOctokit(octokit as unknown as OctokitLike),
      publisherLogin: `${config.appSlug}[bot]`,
    };
  };
}
