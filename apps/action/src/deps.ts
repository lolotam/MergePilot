import type { CredentialStore, MergePilotConfig, ReviewModel } from '@mergepilot/engine';
import type { GitHubClient } from '@mergepilot/github';

/** Everything the Action touches outside its own code, injectable so tests need no real I/O. */
export interface ActionDeps {
  env?: Record<string, string | undefined>;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  createClient?: (token: string) => GitHubClient;
  createModel?: (
    config: MergePilotConfig,
    store: CredentialStore,
    opts: { cwd: string },
  ) => Promise<ReviewModel>;
  log?: (message: string) => void;
  cwd?: () => string;
}
