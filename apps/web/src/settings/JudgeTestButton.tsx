import { useState } from 'react';
import { CheckCircle2, Plug, XCircle } from 'lucide-react';
import { api, type TestConnectionResponse } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { runConnectionTest, useTestReason } from './TestKeyButton.js';

export interface JudgeTestButtonProps {
  workspaceId: string;
  provider: string;
  /** Jev model to test; the provider's default when left out. */
  model?: string | undefined;
  disabled?: boolean | undefined;
}

/** Sends one tiny Jev question with the stored key and shows `ok · model · ms` or the reason. */
export function JudgeTestButton({ workspaceId, provider, model, disabled = false }: JudgeTestButtonProps) {
  const { t } = useI18n();
  const reason = useTestReason();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestConnectionResponse | null>(null);

  const handleTest = async () => {
    setIsLoading(true);
    setResult(null);
    setResult(await runConnectionTest(() => api.testJudge(workspaceId, { provider, ...(model ? { model } : {}) })));
    setIsLoading(false);
  };

  const failure = result && !result.ok ? reason(result.code) : '';
  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={disabled || isLoading}
        onClick={() => void handleTest()}
        aria-label={`${t('judgeTestButton')} (${provider})`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-ink-200 dark:border-ink-700 text-xs text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-50 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
      >
        {isLoading ? (
          <span className="w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Plug className="w-3.5 h-3.5" />
        )}
        <span>{t('judgeTestButton')}</span>
      </button>
      <span role="status" aria-live="polite" className="inline-flex">
        {result &&
          (result.ok ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
              <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
              <span dir="ltr">{t('judgeTestOk', { model: result.model ?? '', ms: String(result.ms ?? 0) })}</span>
            </span>
          ) : (
            <span
              title={result.message ? `${failure}: ${result.message}` : failure}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] cursor-help bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
            >
              <XCircle className="w-3 h-3" aria-hidden="true" />
              <span className="truncate max-w-[200px]">{failure}</span>
            </span>
          ))}
      </span>
    </div>
  );
}
