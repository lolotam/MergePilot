import { randomUUID } from 'node:crypto';
import { loginSubscription, type SubscriptionCredential, type SubscriptionInteraction, type SubscriptionProvider } from '@mergepilot/engine';
import type { SubscriptionLogin } from '../api/contract-subscriptions.js';

export type SubscriptionLoginFn = (provider: SubscriptionProvider, interaction: SubscriptionInteraction) => Promise<SubscriptionCredential>;
interface Attempt {
  workspaceId: string;
  userId: string;
  state: SubscriptionLogin;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  answer?: ((value: string) => void) | undefined;
  credential?: SubscriptionCredential | undefined;
  committing?: Promise<void> | undefined;
}

/** Short-lived, user/workspace-bound login conversations. Restarting the web process requires a new login. */
export class SubscriptionLogins {
  private readonly attempts = new Map<string, Attempt>();
  constructor(private readonly login: SubscriptionLoginFn = loginSubscription, private readonly lifetimeMs = 15 * 60_000) {}

  start(workspaceId: string, userId: string, provider: SubscriptionProvider): SubscriptionLogin {
    if (this.attempts.size >= 1000) throw new Error('Too many active subscription logins');
    for (const attempt of this.attempts.values()) {
      if (attempt.workspaceId === workspaceId && attempt.userId === userId && attempt.state.provider === provider) this.cancel(attempt);
    }
    const id = randomUUID();
    const controller = new AbortController();
    const attempt: Attempt = {
      workspaceId, userId, controller,
      state: { id, provider, status: 'pending', expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString() },
      timer: setTimeout(() => { this.cancel(attempt); this.attempts.delete(id); }, this.lifetimeMs),
    };
    attempt.timer.unref();
    this.attempts.set(id, attempt);
    void this.run(attempt);
    return this.snapshot(attempt);
  }

  private async run(attempt: Attempt): Promise<void> {
    try {
      const credential = await this.login(attempt.state.provider, {
        signal: attempt.controller.signal,
        notify: (event) => {
          if (attempt.controller.signal.aborted) return;
          if (event.type === 'auth_url') attempt.state.notice = { message: event.instructions ?? 'Open the sign-in page', url: event.url };
          else if (event.type === 'device_code') attempt.state.notice = { message: 'Enter this code on the sign-in page', url: event.verificationUri, code: event.userCode };
          // Keep the sign-in URL visible during exchange/polling.
          else if (event.type === 'info' && !attempt.state.notice) attempt.state.notice = { message: event.message };
        },
        prompt: (prompt) => new Promise<string>((resolve, reject) => {
          const signal = prompt.signal ? AbortSignal.any([prompt.signal, attempt.controller.signal]) : attempt.controller.signal;
          signal.throwIfAborted();
          if (prompt.type === 'select') { reject(new Error('Unsupported login prompt')); return; }
          const id = randomUUID();
          const abort = () => { cleanup(); reject(new Error('Login cancelled')); };
          const cleanup = () => {
            signal.removeEventListener('abort', abort);
            delete attempt.answer;
            delete attempt.state.prompt;
          };
          attempt.state.prompt = { id, message: prompt.message, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) };
          attempt.answer = (value) => { cleanup(); resolve(value); };
          signal.addEventListener('abort', abort, { once: true });
        }),
      });
      if (attempt.controller.signal.aborted) return;
      attempt.credential = credential;
      attempt.state.status = 'ready';
      delete attempt.state.prompt;
    } catch {
      if (attempt.controller.signal.aborted) return;
      attempt.state.status = 'failed';
      attempt.state.error = 'Subscription sign-in failed. Start a new sign-in and try again.';
      delete attempt.state.prompt;
      delete attempt.answer;
    }
  }

  get(workspaceId: string, userId: string, id: string): Attempt | undefined {
    const attempt = this.attempts.get(id);
    return attempt?.workspaceId === workspaceId && attempt.userId === userId ? attempt : undefined;
  }

  snapshot(attempt: Attempt): SubscriptionLogin {
    return structuredClone(attempt.state);
  }

  answer(attempt: Attempt, promptId: string, value: string): boolean {
    if (attempt.state.status !== 'pending' || attempt.state.prompt?.id !== promptId || !attempt.answer) return false;
    attempt.answer(value);
    return true;
  }

  async finish(attempt: Attempt, save: (provider: SubscriptionProvider, credential: SubscriptionCredential, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (attempt.state.status === 'completed') return true;
    if (attempt.state.status !== 'ready' || !attempt.credential || attempt.controller.signal.aborted) return false;
    if (!attempt.committing) {
      attempt.committing = save(attempt.state.provider, attempt.credential, attempt.controller.signal).then(() => {
        attempt.state.status = 'completed';
        delete attempt.credential;
        delete attempt.state.notice;
      }).finally(() => { delete attempt.committing; });
    }
    await attempt.committing;
    return true;
  }

  cancel(attempt: Attempt): void {
    if (attempt.state.status === 'completed') return;
    attempt.state.status = 'cancelled';
    attempt.controller.abort();
    delete attempt.credential;
    delete attempt.answer;
    delete attempt.state.prompt;
    delete attempt.state.notice;
  }

  /** Wait for an in-flight save so DELETE reports cancellation only if persistence did not win. */
  async cancelAndWait(attempt: Attempt): Promise<boolean> {
    const committing = attempt.committing;
    this.cancel(attempt);
    if (committing) {
      try { await committing; }
      catch { /* A cancelled save preserves the previous credential and keeps cancelled status. */ }
    }
    return attempt.state.status !== 'completed';
  }

  close(): void {
    for (const attempt of this.attempts.values()) { clearTimeout(attempt.timer); this.cancel(attempt); }
    this.attempts.clear();
  }
}
