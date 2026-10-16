/**
 * Google Antigravity sign-in for a web server (ADR-0032 §4): Authorization Code + PKCE S256 with
 * the client's loopback redirect. MergePilot never listens on that port; after signing in the user
 * pastes the address the browser could not open, and the server checks `state` and exchanges the
 * code. Then `loadCodeAssist` / `onboardUser` give the Cloud Code Assist project.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type { SubscriptionCredential } from '../../../credentials/subscription.js';
import { antigravityHeaders, ANTIGRAVITY_CLIENT_METADATA, type AntigravityClient } from './config.js';
import { fetchWithHosts } from './transport.js';

export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback';
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;

/** Why a sign-in failed, in words the dashboard may show. Google's own bodies are never kept. */
export const SUBSCRIPTION_LOGIN_FAILURES = [
  'denied',
  'state-mismatch',
  'invalid-paste',
  'token-exchange',
  'validation-required',
  'ineligible',
  'project-required',
] as const;
export type SubscriptionLoginFailure = (typeof SUBSCRIPTION_LOGIN_FAILURES)[number];

export class SubscriptionLoginError extends Error {
  constructor(readonly reason: SubscriptionLoginFailure) {
    super(`Subscription sign-in failed: ${reason}`);
    this.name = 'SubscriptionLoginError';
  }
}

export interface AntigravityDeps {
  client: AntigravityClient;
  fetch?: typeof fetch;
  now?: () => number;
  /** Wait between onboarding polls; tests pass a no-op. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const ONBOARD_POLL_MS = 5_000;
const ONBOARD_MAX_POLLS = 24;

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()), state: base64url(randomBytes(24)) };
}

export function authorizationUrl(client: AntigravityClient, pkce: { challenge: string; state: string }): string {
  const url = new URL(ANTIGRAVITY_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    scope: ANTIGRAVITY_SCOPES.join(' '),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

/** The authorization code from the pasted redirect address, after checking its `state`. */
export function codeFromPastedUrl(pasted: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new SubscriptionLoginError('invalid-paste');
  }
  const params = url.searchParams;
  if (params.get('error')) throw new SubscriptionLoginError('denied');
  if (params.get('state') !== expectedState) throw new SubscriptionLoginError('state-mismatch');
  const code = params.get('code');
  if (!code) throw new SubscriptionLoginError('invalid-paste');
  return code;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

async function postToken(deps: AntigravityDeps, form: Record<string, string>, signal: AbortSignal): Promise<TokenResponse> {
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...form, client_id: deps.client.clientId, client_secret: deps.client.clientSecret }).toString(),
    signal,
  });
  // The body of a failed token call can echo the request; it is dropped, not parsed into a message.
  if (!response.ok) throw new SubscriptionLoginError('token-exchange');
  return (await response.json()) as TokenResponse;
}

function expiresAt(deps: AntigravityDeps, expiresIn: unknown): number {
  const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  // The credential service refreshes a minute before this (ADR-0020), so no extra margin here.
  return (deps.now ?? Date.now)() + seconds * 1000;
}

interface Tier {
  id?: unknown;
  isDefault?: unknown;
  userDefinedCloudaicompanionProject?: unknown;
}

interface LoadCodeAssistResponse {
  currentTier?: Tier;
  allowedTiers?: Tier[];
  ineligibleTiers?: Array<{ reasonCode?: unknown }>;
  cloudaicompanionProject?: unknown;
}

function projectIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id || undefined;
  return undefined;
}

async function postCodeAssist(deps: AntigravityDeps, access: string, method: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetchWithHosts(deps.fetch ?? fetch, method, {
    method: 'POST', headers: antigravityHeaders(access), body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (/VALIDATION_REQUIRED/.test(text)) throw new SubscriptionLoginError('validation-required');
    if (response.status === 403) throw new SubscriptionLoginError('ineligible');
    // Any other answer (5xx, 401, 429) is not about the account: the generic sign-in failure.
    throw new Error(`Cloud Code Assist ${method} answered HTTP ${response.status}`);
  }
  return response.json();
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Login cancelled')); }, { once: true });
  });
}

/** The Cloud Code Assist project and tier of a personal account (decisions log س46-هـ). */
export async function setupCodeAssist(deps: AntigravityDeps, access: string, signal: AbortSignal): Promise<{ projectId: string; tier: string }> {
  const loaded = (await postCodeAssist(deps, access, 'loadCodeAssist', { metadata: { ...ANTIGRAVITY_CLIENT_METADATA } }, signal)) as LoadCodeAssistResponse;
  const ineligible = loaded.ineligibleTiers ?? [];
  if (!loaded.currentTier && ineligible.some((tier) => tier.reasonCode === 'VALIDATION_REQUIRED')) {
    throw new SubscriptionLoginError('validation-required');
  }
  if (loaded.currentTier) {
    const projectId = projectIdOf(loaded.cloudaicompanionProject);
    if (!projectId) throw new SubscriptionLoginError(ineligible.length > 0 ? 'ineligible' : 'project-required');
    return { projectId, tier: typeof loaded.currentTier.id === 'string' ? loaded.currentTier.id : 'unknown' };
  }
  const tier = loaded.allowedTiers?.find((entry) => entry.isDefault === true);
  if (!tier || typeof tier.id !== 'string') throw new SubscriptionLoginError('ineligible');
  // A tier that needs the user's own Google Cloud project is a business account: not in scope (س46-هـ).
  if (tier.userDefinedCloudaicompanionProject === true) throw new SubscriptionLoginError('project-required');
  return { projectId: await onboard(deps, access, tier.id, signal), tier: tier.id };
}

/** `onboardUser` is a long-running operation: asked again every 5 s until done, for up to 2 minutes. */
async function onboard(deps: AntigravityDeps, access: string, tierId: string, signal: AbortSignal): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let poll = 0; poll < ONBOARD_MAX_POLLS; poll++) {
    const operation = (await postCodeAssist(deps, access, 'onboardUser', { tierId, metadata: { ...ANTIGRAVITY_CLIENT_METADATA } }, signal)) as {
      done?: unknown; response?: { cloudaicompanionProject?: unknown };
    };
    if (operation.done === true) {
      const projectId = projectIdOf(operation.response?.cloudaicompanionProject);
      if (!projectId) throw new SubscriptionLoginError('ineligible');
      return projectId;
    }
    await sleep(ONBOARD_POLL_MS, signal);
  }
  throw new SubscriptionLoginError('ineligible');
}

async function exchangeCode(deps: AntigravityDeps, code: string, verifier: string, signal: AbortSignal): Promise<{ access: string; refresh: string; expires: number }> {
  const tokens = await postToken(deps, {
    grant_type: 'authorization_code', code, redirect_uri: ANTIGRAVITY_REDIRECT_URI, code_verifier: verifier,
  }, signal);
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new SubscriptionLoginError('token-exchange');
  }
  return { access: tokens.access_token, refresh: tokens.refresh_token, expires: expiresAt(deps, tokens.expires_in) };
}

export async function loginAntigravity(interaction: AuthInteraction, deps: AntigravityDeps): Promise<SubscriptionCredential> {
  const signal = interaction.signal ?? new AbortController().signal;
  const pkce = createPkce();
  interaction.notify({
    type: 'auth_url',
    url: authorizationUrl(deps.client, pkce),
    instructions: 'Sign in with Google. The browser then fails to open a localhost page: copy that whole address and paste it here.',
  });
  const pasted = await interaction.prompt({
    type: 'text',
    message: 'Paste the full address from the browser after signing in',
    placeholder: `${ANTIGRAVITY_REDIRECT_URI}?state=…&code=…`,
    signal,
  });
  const tokens = await exchangeCode(deps, codeFromPastedUrl(pasted, pkce.state), pkce.verifier, signal);
  const project = await setupCodeAssist(deps, tokens.access, signal);
  return { type: 'oauth', ...tokens, projectId: project.projectId, tier: project.tier };
}

/** A new access token; Google keeps the refresh token unless it sends a new one. */
export async function refreshAntigravity(credential: SubscriptionCredential, deps: AntigravityDeps, signal: AbortSignal): Promise<SubscriptionCredential> {
  const tokens = await postToken(deps, { grant_type: 'refresh_token', refresh_token: credential.refresh }, signal);
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new SubscriptionLoginError('token-exchange');
  return {
    ...credential,
    access: tokens.access_token,
    refresh: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : credential.refresh,
    expires: expiresAt(deps, tokens.expires_in),
  };
}
