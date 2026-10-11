import type { ApiProvider } from '../core/types.js';

export class ValidateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidateKeyError';
  }
}

export async function validateKey(
  provider: ApiProvider,
  apiKey: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new ValidateKeyError('API key cannot be empty');
  }

  let url: string;
  const headers: Record<string, string> = {};

  switch (provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/models';
      headers['x-api-key'] = trimmed;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'openai':
      url = 'https://api.openai.com/v1/models';
      headers['Authorization'] = `Bearer ${trimmed}`;
      break;
    case 'gemini':
      url = 'https://generativelanguage.googleapis.com/v1beta/models';
      headers['x-goog-api-key'] = trimmed;
      break;
    default: {
      const exhaustiveCheck: never = provider;
      throw new ValidateKeyError(`Unsupported provider: ${String(exhaustiveCheck)}`);
    }
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers,
    });
  } catch {
    // Network errors -> "could not verify"; never leak the key
    throw new ValidateKeyError('could not verify');
  }

  if (response.status === 401 || response.status === 403) {
    throw new ValidateKeyError(`invalid key for ${provider}`);
  }

  if (!response.ok) {
    throw new ValidateKeyError('could not verify');
  }
}
