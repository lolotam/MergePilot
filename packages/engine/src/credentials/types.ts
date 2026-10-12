import type { ProviderId } from '../providers/ids.js';

/**
 * The providers the first shells (Action, SaaS) were built against. Kept as-is so existing
 * `Record<CredentialProvider, ...>` maps keep compiling; every provider id (ADR-0008) is
 * `ProviderId`, and the credential types take it as their type parameter.
 */
export type CredentialProvider = 'anthropic' | 'openai' | 'gemini' | 'claude-code';

/** Any provider a credential can belong to. */
export type AnyCredentialProvider = ProviderId;

export interface CredentialRef<P extends AnyCredentialProvider = CredentialProvider> {
  provider: P;
}

export interface CredentialInfo<P extends AnyCredentialProvider = CredentialProvider> {
  provider: P;
  configured: boolean;
  source: 'env' | 'none';
  envName: string;
}

export type RequestPurpose = 'review' | 'validate-connection';
