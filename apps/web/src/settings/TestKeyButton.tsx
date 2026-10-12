import { useState } from 'react';
import { CheckCircle2, Plug, XCircle } from 'lucide-react';
import { api, ApiClientError, type ApiProvider, type TestConnectionResponse } from '../api/client.js';
import type { I18nKey } from '../i18n/ar.js';
import { useI18n } from '../i18n/context.js';

const REASONS: Record<string, I18nKey> = {
  auth: 'testReasonAuth',
  quota: 'testReasonQuota',
  'rate-limit': 'testReasonRateLimit',
  rate_limited: 'testReasonRateLimit',
  network: 'testReasonNetwork',
  server: 'testReasonServer',
  timeout: 'testReasonTimeout',
  'bad-request': 'testReasonBadRequest',
  'invalid-response': 'testReasonInvalidResponse',
};

/** The translated reason for a failed connection test code (`auth`, `quota`, ...). */
export function useTestReason(): (code: string | undefined) => string {
  const { t } = useI18n();
  return (code) => t((code && REASONS[code]) || 'testReasonOther');
}

/** Runs a connection test and turns a thrown API error into a failed result. */
export async function runConnectionTest(
  run: () => Promise<TestConnectionResponse>,
): Promise<TestConnectionResponse> {
  try {
    return await run();
  } catch (err) {
    const code = err instanceof ApiClientError ? err.code : 'network';
    const message = err instanceof Error ? err.message : '';
    return { ok: false, code, message };
  }
}

export interface TestKeyButtonProps {
  workspaceId: string;
  provider: ApiProvider;
  disabled?: boolean;
}

/** Per-key test icon: idle → spinner → ✓ with latency, or ✗ with the reason (details on hover). */
export function TestKeyButton({ workspaceId, provider, disabled = false }: TestKeyButtonProps) {
  const { t } = useI18n();
  const reason = useTestReason();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestConnectionResponse | null>(null);

  const handleTest = async () => {
    setIsLoading(true);
    setResult(null);
    setResult(await runConnectionTest(() => api.testConnection(workspaceId, provider)));
    setIsLoading(false);
  };

  const failure = result && !result.ok ? reason(result.code) : '';
  const detail = result && !result.ok && result.message ? `${failure}: ${result.message}` : failure;

  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={disabled || isLoading}
        onClick={() => void handleTest()}
        title={t('testKeyAction')}
        aria-label={`${t('testKeyAction')} (${provider})`}
        className="p-1.5 rounded-lg border border-ink-200 dark:border-ink-700 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-50 text-ink-600 dark:text-ink-300 transition-colors inline-flex items-center justify-center focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
      >
        {isLoading ? (
          <span className="w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Plug className="w-3.5 h-3.5" />
        )}
      </button>
      <span role="status" aria-live="polite" className="inline-flex">
        {result &&
          (result.ok ? (
            <span
              title={t('testKeySuccess', { ms: String(result.ms ?? 0) })}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
            >
              <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
              <span dir="ltr">{result.ms ?? 0}ms</span>
            </span>
          ) : (
            <span
              title={detail}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] cursor-help bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
            >
              <XCircle className="w-3 h-3" aria-hidden="true" />
              <span className="truncate max-w-[160px]">{failure}</span>
            </span>
          ))}
      </span>
    </div>
  );
}
