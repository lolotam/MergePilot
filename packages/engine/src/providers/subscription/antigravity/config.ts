/**
 * Google Antigravity subscription (ADR-0032). The OAuth client is a Google "installed application"
 * client whose ID and non-confidential secret ship inside the official Antigravity application.
 * MergePilot does not commit them: the deployment supplies both (decisions log س47-ب), and the
 * provider stays unavailable without them.
 */
export const ANTIGRAVITY_CLIENT_ID_ENV = 'GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID';
export const ANTIGRAVITY_CLIENT_SECRET_ENV = 'GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET';

export interface AntigravityClient {
  clientId: string;
  clientSecret: string;
}

/** The configured OAuth client, or undefined when either value is missing. */
export function antigravityClientFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): AntigravityClient | undefined {
  const clientId = env[ANTIGRAVITY_CLIENT_ID_ENV]?.trim();
  const clientSecret = env[ANTIGRAVITY_CLIENT_SECRET_ENV]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export function isAntigravityConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return antigravityClientFromEnv(env) !== undefined;
}

/** Fixed API hosts, tried in this order (ADR-0032 §7). Never taken from repository or dashboard input. */
export const ANTIGRAVITY_HOSTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

export const ANTIGRAVITY_API_VERSION = 'v1internal';

/**
 * The identity the Antigravity application sends (allowed by س45). Google may change or check
 * these at any time; a mismatch surfaces as an `LlmFailure`, never as a silent fallback.
 */
export const ANTIGRAVITY_USER_AGENT = 'antigravity/1.15.8 linux/amd64';
export const ANTIGRAVITY_API_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
export const ANTIGRAVITY_CLIENT_METADATA = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } as const;

export function antigravityHeaders(accessToken: string, stream = false): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT,
    'X-Goog-Api-Client': ANTIGRAVITY_API_CLIENT,
    'Client-Metadata': JSON.stringify(ANTIGRAVITY_CLIENT_METADATA),
    ...(stream ? { Accept: 'text/event-stream' } : {}),
  };
}

export function antigravityUrl(host: string, method: string): string {
  return `${host}/${ANTIGRAVITY_API_VERSION}:${method}`;
}
