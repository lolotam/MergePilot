export type CredentialProvider = 'anthropic' | 'openai' | 'gemini' | 'claude-code';

export interface CredentialRef {
  provider: CredentialProvider;
}

export interface CredentialInfo {
  provider: CredentialProvider;
  configured: boolean;
  source: 'env' | 'none';
  envName: string;
}

export type RequestPurpose = 'review' | 'validate-connection';
