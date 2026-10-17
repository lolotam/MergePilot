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

/** A failed refresh with a fixed message; upstream bodies are never part of it. */
export class SubscriptionRefreshError extends Error {
  constructor(readonly reason: SubscriptionRefreshFailure) {
    super(MESSAGES[reason]);
    this.name = 'SubscriptionRefreshError';
  }

  get transient(): boolean {
    return this.reason === 'unreachable';
  }
}
