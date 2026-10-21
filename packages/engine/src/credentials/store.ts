import { PROVIDER_REGISTRY } from '../providers/registry.js';
import { Secret } from './secret.js';
import { SUBSCRIPTION_PREFIX } from './subscription.js';
import type {
  AnyCredentialProvider,
  CredentialInfo,
  CredentialProvider,
  CredentialRef,
  RequestPurpose,
} from './types.js';

export class MissingCredentialError extends Error {
  readonly envName: string;

  constructor(envName: string, message?: string) {
    super(message ?? `Missing credential: ${envName} is not set or is blank`);
    this.name = 'MissingCredentialError';
    this.envName = envName;
  }
}

/**
 * The variable holds a dashboard subscription envelope (ADR-0038). The Action cannot persist a rotated
 * refresh token, so it accepts API keys only. The message is fixed text and never includes the value.
 */
export class SubscriptionEnvelopeError extends MissingCredentialError {
  constructor(envName: string) {
    super(
      envName,
      `${envName} holds a MergePilot dashboard subscription sign-in, which the GitHub Action does not accept. ` +
        'Use an API key, or provider: claude-code with CLAUDE_CODE_OAUTH_TOKEN; subscriptions run through the GitHub App.',
    );
    this.name = 'SubscriptionEnvelopeError';
  }
}

/**
 * Where the engine gets keys (ADR-0002). `P` is the set of providers a store serves; stores
 * written for the first three providers keep the default and still fit wherever the engine
 * asks for any provider (method parameters are bivariant), so they simply report the newer
 * providers as not configured.
 */
export interface CredentialStore<P extends AnyCredentialProvider = CredentialProvider> {
  info(ref: CredentialRef<P>): Promise<CredentialInfo<P>>;
  resolve(ref: CredentialRef<P>, purpose: RequestPurpose): Promise<Secret>;
}

/** A store that may be asked for any provider id. */
export type AnyCredentialStore = CredentialStore<AnyCredentialProvider>;

const PROVIDER_ENV_MAP: Record<AnyCredentialProvider, string> = {
  ...(Object.fromEntries(Object.values(PROVIDER_REGISTRY).map((entry) => [entry.id, entry.envName])) as Record<
    Exclude<AnyCredentialProvider, 'claude-code'>,
    string
  >),
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** The environment variable that holds a provider's key in the Action. */
export function credentialEnvName(provider: AnyCredentialProvider): string {
  return PROVIDER_ENV_MAP[provider];
}

export type EnvRecord = Record<string, string | undefined>;

export class EnvCredentialStore implements CredentialStore<AnyCredentialProvider> {
  readonly #env: EnvRecord;

  constructor(env: EnvRecord = process.env) {
    this.#env = env;
  }

  async info<P extends AnyCredentialProvider>(ref: CredentialRef<P>): Promise<CredentialInfo<P>> {
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

  async resolve(ref: CredentialRef<AnyCredentialProvider>, _purpose: RequestPurpose): Promise<Secret> {
    const envName = PROVIDER_ENV_MAP[ref.provider];
    const raw = this.#env[envName];
    const trimmed = raw !== undefined ? raw.trim() : '';

    if (trimmed.length === 0) {
      throw new MissingCredentialError(envName);
    }
    // A prefix check only: the envelope is never decoded, so its tokens are never handled here.
    if (trimmed.startsWith(SUBSCRIPTION_PREFIX)) {
      throw new SubscriptionEnvelopeError(envName);
    }

    return new Secret(trimmed);
  }
}
