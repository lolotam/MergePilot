/**
 * A failed subscription token refresh. `transient` is true when the provider could not be reached
 * or answered a server error, so trying again later may work; false when the sign-in itself is no
 * longer valid (for example `invalid_grant`). Upstream bodies are never part of the message.
 */
export class SubscriptionRefreshError extends Error {
  constructor(readonly transient: boolean) {
    super(transient
      ? 'Subscription token refresh could not reach the provider; try again'
      : 'Subscription token refresh failed; sign in again');
    this.name = 'SubscriptionRefreshError';
  }
}
