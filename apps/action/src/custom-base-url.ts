import type { MergePilotConfig } from '@mergepilot/engine';

/**
 * The `custom` provider's server URL from a TRUSTED source: the `custom-base-url` action input
 * or the `CUSTOM_LLM_BASE_URL` env var, both set in the workflow by the repository owner. The
 * `.mergepilot.yml` `baseUrl` is never used: a key must not go to a URL from repo content
 * (ADR-0008 amendment).
 */
export function trustedCustomBaseUrl(env: Record<string, string | undefined>): string | undefined {
  const value = env['INPUT_CUSTOM-BASE-URL'] || env.INPUT_CUSTOM_BASE_URL || env.CUSTOM_LLM_BASE_URL;
  return value?.trim() || undefined;
}

/** Warns when the config file names a base URL, which is ignored. */
export function warnIgnoredBaseUrls(config: MergePilotConfig, log: (msg: string) => void): void {
  const named = config.baseUrl !== undefined || (config.fallback ?? []).some((entry) => entry.baseUrl !== undefined);
  if (named) {
    log(
      'Warning: baseUrl in .mergepilot.yml is ignored; set the custom server URL with the custom-base-url input or CUSTOM_LLM_BASE_URL.',
    );
  }
}
