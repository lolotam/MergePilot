/**
 * Server configuration, read from environment variables set in Dokploy secrets.
 * Missing values are reported together, by name, never with their values.
 */
export interface AppConfig {
  baseUrl: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  masterKey: string;
  github: {
    appId: string;
    privateKey: string;
    webhookSecret: string;
    clientId: string;
    clientSecret: string;
    /** Public slug of the GitHub App, used for the install link and the bot login. */
    appSlug: string;
  };
  google: { clientId: string; clientSecret: string };
  authSecret: string;
  /** MERGEPILOT_PLATFORM_ADMINS: lower-cased operator emails. Empty means nobody. */
  platformAdmins?: string[];
}

const REQUIRED = [
  'MERGEPILOT_BASE_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'MERGEPILOT_MASTER_KEY',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'BETTER_AUTH_SECRET',
] as const;

/** Parses MERGEPILOT_PLATFORM_ADMINS: comma-separated, trimmed, lower-cased, empties dropped. */
export function parsePlatformAdmins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export function loadAppConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const get = (name: (typeof REQUIRED)[number]): string => (env[name] ?? '').trim();
  return {
    baseUrl: get('MERGEPILOT_BASE_URL').replace(/\/$/, ''),
    port: Number(env.PORT ?? 3000),
    databaseUrl: get('DATABASE_URL'),
    redisUrl: get('REDIS_URL'),
    masterKey: get('MERGEPILOT_MASTER_KEY'),
    github: {
      appId: get('GITHUB_APP_ID'),
      // Dokploy stores multi-line values fine, but accept "\n"-escaped PEMs too.
      privateKey: get('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
      webhookSecret: get('GITHUB_WEBHOOK_SECRET'),
      clientId: get('GITHUB_CLIENT_ID'),
      clientSecret: get('GITHUB_CLIENT_SECRET'),
      appSlug: (env.GITHUB_APP_SLUG ?? 'mergepilot').trim(),
    },
    google: { clientId: get('GOOGLE_CLIENT_ID'), clientSecret: get('GOOGLE_CLIENT_SECRET') },
    authSecret: get('BETTER_AUTH_SECRET'),
    platformAdmins: parsePlatformAdmins(env.MERGEPILOT_PLATFORM_ADMINS),
  };
}
