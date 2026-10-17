import type { arAntigravity } from './antigravity-ar.js';

/** Google Antigravity subscription (ADR-0032). */
export const enAntigravity: Record<keyof typeof arAntigravity, string> = {
  providerGoogleAntigravity: 'Google Antigravity',
  subscriptionGoogle: 'Sign in with Google (Antigravity)',
  antigravitySubscriptionOnly: 'Google Antigravity works with a subscription sign-in only; it has no API keys.',
  antigravityTermsNotice:
    "Google's terms forbid using third-party tools to access Antigravity. Google may suspend or terminate this account's Antigravity access. Use an account you accept that risk for.",
  antigravityTermsAck: 'I understand the risk to this Google account',
  antigravityPasteHelp:
    'After signing in, the browser opens a page that cannot load (localhost). Copy the whole address from the address bar and paste it below. A program listening on port 51121 on your computer would receive the code instead.',
  antigravityPasteLabel: 'Address from the browser',
  providerUnavailableNote: 'This server does not offer {provider} sign-in, so this saved choice will not work. Choose another provider.',
  subscriptionErrorDenied: 'Google sign-in was cancelled or denied.',
  subscriptionErrorStateMismatch: 'That address belongs to another sign-in. Start a new sign-in and paste the address it opens.',
  subscriptionErrorInvalidPaste: 'Paste the whole address from the browser, starting with http://localhost:51121/.',
  subscriptionErrorTokenExchange: 'Google did not accept the sign-in code. Start a new sign-in.',
  subscriptionErrorValidationRequired: 'Google asks you to verify this account first. Verify it in the browser, then sign in again.',
  subscriptionErrorIneligible: 'This Google account is not eligible for Antigravity.',
  subscriptionErrorProjectRequired: 'This account needs a Google Cloud project; business accounts are not supported yet.',
  subscriptionErrorNotConfigured: 'Google Antigravity sign-in is not configured on this server. Ask the server operator.',
};
