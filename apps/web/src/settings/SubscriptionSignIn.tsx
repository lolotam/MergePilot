import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type SubscriptionLogin, type SubscriptionLoginErrorCode, type SubscriptionProvider } from '../api/client.js';
import type { I18nKey } from '../i18n/ar.js';
import { useI18n } from '../i18n/context.js';
import { fieldClass, labelClass } from './providers.js';
import { isSubscriptionOnlyProvider } from './subscription-only.js';

const buttonClass = 'px-4 py-2 rounded-full bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand-500';

const LOGIN_ERROR_KEYS: Record<SubscriptionLoginErrorCode, I18nKey> = {
  denied: 'subscriptionErrorDenied',
  'state-mismatch': 'subscriptionErrorStateMismatch',
  'invalid-paste': 'subscriptionErrorInvalidPaste',
  'token-exchange': 'subscriptionErrorTokenExchange',
  'validation-required': 'subscriptionErrorValidationRequired',
  ineligible: 'subscriptionErrorIneligible',
  'project-required': 'subscriptionErrorProjectRequired',
};

const SIGN_IN_LABELS: Record<SubscriptionProvider, I18nKey> = {
  openai: 'subscriptionChatgpt',
  anthropic: 'subscriptionClaude',
  xai: 'subscriptionGrok',
  'google-antigravity': 'subscriptionGoogle',
};

/**
 * Device-code login for Codex/Grok; copy-code login for Claude; paste-the-address login for
 * Google Antigravity, behind its terms acknowledgement (ADR-0032), inside the credential dialog.
 */
export function SubscriptionSignIn({ workspaceId, provider, onConnected }: {
  workspaceId: string; provider: SubscriptionProvider; onConnected: () => void;
}) {
  const { t } = useI18n();
  const cache = useQueryClient();
  const termsRequired = isSubscriptionOnlyProvider(provider);
  const [acknowledged, setAcknowledged] = useState(false);
  const [login, setLogin] = useState<SubscriptionLogin>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeId = useRef<string | undefined>(undefined);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeId.current) void api.cancelSubscription(workspaceId, activeId.current).catch(() => undefined);
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!login || !['pending', 'ready'].includes(login.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.getSubscriptionLogin(workspaceId, login.id);
        if (stopped) return;
        if (next.status === 'ready') {
          const saved = await api.finishSubscription(workspaceId, login.id);
          if (stopped) return;
          setLogin(saved);
          activeId.current = undefined;
          void cache.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
          connected.current();
          return;
        }
        setLogin(next);
        if (next.status === 'pending') timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : t('error'));
      }
    };
    timer = setTimeout(poll, 500);
    return () => { stopped = true; clearTimeout(timer); };
    // Each poll owns its loop; setting a new snapshot must not spawn a second loop.
  }, [login?.id, workspaceId, cache, t]);

  const start = async () => {
    setBusy(true); setError(''); setCode('');
    try {
      if (activeId.current) await api.cancelSubscription(workspaceId, activeId.current);
      const next = await api.startSubscription(workspaceId, provider, termsRequired && acknowledged);
      if (!mounted.current) { void api.cancelSubscription(workspaceId, next.id).catch(() => undefined); return; }
      activeId.current = next.id;
      setLogin(next);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('error')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const submitCode = async () => {
    if (!login?.prompt || !code.trim()) return;
    setBusy(true); setError('');
    try {
      const next = await api.answerSubscription(workspaceId, login.id, login.prompt.id, code.trim());
      if (mounted.current) { setCode(''); setLogin(next); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('error')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const pending = login?.status === 'pending' || login?.status === 'ready';
  const label = t(SIGN_IN_LABELS[provider]);
  const url = login?.notice?.url;
  const safeUrl = url?.startsWith('https://') ? url : undefined;
  const loginError = login?.errorCode ? t(LOGIN_ERROR_KEYS[login.errorCode]) : login?.error;
  return <div className="flex flex-col gap-3">
    <p className="text-xs text-ink-500 dark:text-ink-400">{t(termsRequired ? 'antigravitySubscriptionOnly' : 'subscriptionHelp')}</p>
    {termsRequired && !pending && <div className="p-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 flex flex-col gap-2">
      <p role="note" className="text-xs text-amber-900 dark:text-amber-200">{t('antigravityTermsNotice')}</p>
      <label className="flex items-center gap-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        {t('antigravityTermsAck')}
      </label>
    </div>}
    {!pending && <button type="button" className={buttonClass} onClick={start} disabled={busy || (termsRequired && !acknowledged)}>{busy ? t('subscriptionStarting') : label}</button>}
    {pending && <div className="p-3 rounded-xl border border-ink-200 dark:border-ink-700 flex flex-col gap-3" role="status">
      {safeUrl && <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-brand-600 underline focus-visible:ring-2 focus-visible:ring-brand-500">{t('subscriptionOpenPage')}</a>}
      {login.notice?.code && <div>
        <p className="text-xs text-ink-500 mb-1">{t('subscriptionDeviceCode')}</p>
        <code dir="ltr" className="text-lg font-mono font-bold select-all">{login.notice.code}</code>
      </div>}
      <p className="text-xs text-ink-500">{login.prompt ? t(termsRequired ? 'antigravityPasteHelp' : 'subscriptionPasteHelp') : t('subscriptionWaiting')}</p>
    </div>}
    {pending && login.prompt && <div>
      <label htmlFor="subscription-code" className={labelClass}>{t(termsRequired ? 'antigravityPasteLabel' : 'subscriptionCodeLabel')}</label>
      <input id="subscription-code" type="password" value={code} autoComplete="off" spellCheck={false} dir="ltr"
        onChange={(event) => setCode(event.target.value)} className={fieldClass} />
      <button type="button" className={`${buttonClass} mt-2`} disabled={busy || !code.trim()} onClick={submitCode}>{t('subscriptionSubmitCode')}</button>
    </div>}
    {(error || loginError) && <p role="alert" className="text-xs text-red-600">{error || loginError}</p>}
    {error && pending && <button type="button" className={buttonClass} onClick={start} disabled={busy}>{t('subscriptionRetry')}</button>}
    {login?.status === 'completed' && <p role="status" className="text-xs text-emerald-600">{t('subscriptionConnected')}</p>}
  </div>;
}
