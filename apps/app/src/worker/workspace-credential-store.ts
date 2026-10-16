import { decodeSubscription, type CredentialInfo, type CredentialRef, type CredentialStore, type RequestPurpose, type Secret } from '@mergepilot/engine';
import type { ApiProvider } from '../core/types.js';
import type { ProcessReviewCredentials } from './types.js';

/** The engine's view of a workspace's stored keys during one review; every resolved key is known for redaction. */
export class WorkspaceCredentialStore implements CredentialStore {
  private readonly secrets = new Map<string, Secret>();
  private readonly extra: Secret[] = [];

  constructor(
    private readonly workspaceId: string,
    private readonly credentials: ProcessReviewCredentials,
    primaryProvider: ApiProvider,
    primarySecret: Secret,
  ) {
    this.secrets.set(primaryProvider, primarySecret);
  }

  /** Adds a key resolved elsewhere (the judge's), so it is redacted like the review keys. */
  addKnownSecrets(secrets: readonly Secret[]): void {
    this.extra.push(...secrets);
  }

  getKnownSecrets(): Secret[] {
    return [...this.secrets.values(), ...this.extra];
  }

  async info(ref: CredentialRef): Promise<CredentialInfo> {
    return { provider: ref.provider, configured: true, source: 'env', envName: 'DATABASE' };
  }

  async resolve(ref: CredentialRef, _purpose: RequestPurpose): Promise<Secret> {
    const existing = this.secrets.get(ref.provider);
    if (existing && !decodeSubscription(existing.reveal(), ref.provider)) return existing;
    const provider = ref.provider as ApiProvider;
    const effective = await this.credentials.getEffectiveAuthMethod?.(this.workspaceId, provider);
    // API keys are the chosen method: never read (or refresh) the subscription parent instead.
    if (effective === 'api-key') {
      const roster = await this.credentials.resolveKeyRoster?.(this.workspaceId, provider);
      const start = roster && roster.startIndex >= 0 && roster.startIndex < roster.secrets.length ? roster.startIndex : 0;
      const secret = roster?.secrets[start];
      if (!secret) throw new Error(`No API key is available for provider "${provider}"`);
      this.secrets.set(ref.provider, secret);
      return secret;
    }
    const resolved = await this.credentials.resolve(this.workspaceId, provider);
    this.secrets.set(ref.provider, resolved);
    return resolved;
  }
}
