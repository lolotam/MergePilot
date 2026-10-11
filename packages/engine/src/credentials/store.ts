import { Secret } from './secret.js';
import type { CredentialInfo, CredentialProvider, CredentialRef, RequestPurpose } from './types.js';

export class MissingCredentialError extends Error {
  readonly envName: string;

  constructor(envName: string, message?: string) {
    super(message ?? `Missing credential: ${envName} is not set or is blank`);
    this.name = 'MissingCredentialError';
    this.envName = envName;
  }
}

export interface CredentialStore {
  info(ref: CredentialRef): Promise<CredentialInfo>;
  resolve(ref: CredentialRef, purpose: RequestPurpose): Promise<Secret>;
}

const PROVIDER_ENV_MAP: Record<CredentialProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

export type EnvRecord = Record<string, string | undefined>;

export class EnvCredentialStore implements CredentialStore {
  readonly #env: EnvRecord;

  constructor(env: EnvRecord = process.env) {
    this.#env = env;
  }

  async info(ref: CredentialRef): Promise<CredentialInfo> {
    const envName = PROVIDER_ENV_MAP[ref.provider];
    const raw = this.#env[envName];
    const trimmed = raw !== undefined ? raw.trim() : '';
    const configured = trimmed.length > 0;

    return {
      provider: ref.provider,
      configured,
      source: configured ? 'env' : 'none',
      envName,
    };
  }

  async resolve(ref: CredentialRef, _purpose: RequestPurpose): Promise<Secret> {
    const envName = PROVIDER_ENV_MAP[ref.provider];
    const raw = this.#env[envName];
    const trimmed = raw !== undefined ? raw.trim() : '';

    if (trimmed.length === 0) {
      throw new MissingCredentialError(envName);
    }

    return new Secret(trimmed);
  }
}
