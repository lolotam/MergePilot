/**
 * Why a subscription token refresh failed:
 * - `sign-in`: the sign-in itself is no longer valid (for example `invalid_grant`);
 * - `unreachable`: no answer or a server error, so trying again later may work;
 * - `not-configured`: this server lacks the provider's OAuth client or Google rejects it, an operator problem.
 */
export type SubscriptionRefreshFailure = 'sign-in' | 'unreachable' | 'not-configured';

const MESSAGES: Readonly<Record<SubscriptionRefreshFailure, string>> = {
  'sign-in': 'Subscription token refresh failed; sign in again',
  unreachable: 'Subscription token refresh could not reach the provider; try again',
  'not-configured': 'Google Antigravity sign-in is not configured on this server',
};

/** Diagnostics that are safe to log: the token endpoint's HTTP status and its OAuth `error` code. Never a body or token. */
export interface SubscriptionRefreshDetails {
  readonly status?: number | undefined;
  readonly oauthError?: string | undefined;
}

/** A failed refresh with a fixed message; upstream bodies are never part of it. */
export class SubscriptionRefreshError extends Error {
  readonly status?: number;
  readonly oauthError?: string;

  constructor(readonly reason: SubscriptionRefreshFailure, details: SubscriptionRefreshDetails = {}) {
    super(MESSAGES[reason]);
    this.name = 'SubscriptionRefreshError';
    const status = details.status;
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    const oauthError = details.oauthError;
    if (oauthError !== undefined && /^[a-z_]{1,64}$/.test(oauthError)) this.oauthError = oauthError;
  }

  get transient(): boolean {
    return this.reason === 'unreachable';
  }
}
