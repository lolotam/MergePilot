import { useState } from 'react';
import { api, type ApiProvider, type TestConnectionResponse } from '../api/client.js';
import { useI18n } from '../i18n/context.js';

export interface TestKeyButtonProps {
  workspaceId: string;
  provider: ApiProvider;
  disabled?: boolean;
}

export function TestKeyButton({ workspaceId, provider, disabled = false }: TestKeyButtonProps) {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestConnectionResponse | null>(null);

  const handleTest = async () => {
    setIsLoading(true);
    setResult(null);
    try {
      const res = await api.testConnection(workspaceId, provider);
      setResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ ok: false, message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={disabled || isLoading}
        onClick={handleTest}
        title={t('testKeyAction')}
        aria-label={t('testKeyAction')}
        className="p-1.5 rounded-lg border border-ink-200 dark:border-ink-700 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-50 text-ink-600 dark:text-ink-400 transition-colors flex items-center justify-center text-xs"
      >
        {isLoading ? (
          <span className="w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <span>🔌</span>
        )}
      </button>

      {result && (
        <span
          title={
            result.ok
              ? t('testKeySuccess', { ms: String(result.ms ?? 0) })
              : result.message || result.code || t('error')
          }
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono cursor-help ${
            result.ok
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
              : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
          }`}
        >
          {result.ok ? (
            <>
              <span>✅</span>
              <span>{result.ms}ms</span>
            </>
          ) : (
            <>
              <span>❌</span>
              <span className="truncate max-w-[120px]">{result.code || 'failed'}</span>
            </>
          )}
        </span>
      )}
    </div>
  );
}
