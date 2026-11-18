import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plug, XCircle } from 'lucide-react';
import { api, ApiClientError, type ApiProvider, type KeySlotItem, type TestConnectionResponse } from '../api/client.js';
import type { I18nKey } from '../i18n/ar.js';
import { useI18n } from '../i18n/context.js';
import { useModelsQuery } from './providers.js';

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
  // Jev judge codes (ADR-0015).
  overloaded: 'testReasonServer',
  'model-not-found': 'testReasonBadRequest',
  'invalid-request': 'testReasonBadRequest',
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
  slot?: Pick<KeySlotItem, 'id' | 'last4' | 'position'>;
}

/** Per-key test icon: idle → spinner → ✓ with latency, or ✗ with the reason (details on hover). */
export function TestKeyButton({ workspaceId, provider, disabled = false, slot }: TestKeyButtonProps) {
  const { t } = useI18n();
  const reason = useTestReason();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestConnectionResponse | null>(null);

  // "Auto" ('') lets the server pick (configured model, a free model, then the default); the
  // models list is only fetched once the picker is opened, so the keys page stays cheap.
  const [wantModels, setWantModels] = useState(false);
  const modelsQuery = useModelsQuery(workspaceId, provider, !slot && wantModels);
  const models = modelsQuery.data?.models ?? [];
  const [selectedModel, setSelectedModel] = useState('');

  const handleTest = async () => {
    setIsLoading(true);
    setResult(null);
    const model = selectedModel.trim();
    const modelOptions = model ? { model } : undefined;
    const options = slot ? { keyId: slot.id, ...modelOptions } : modelOptions;
    const outcome = await runConnectionTest(() =>
      options ? api.testConnection(workspaceId, provider, options) : api.testConnection(workspaceId, provider),
    );
    setResult(outcome);
    if (slot && outcome.quotaStatus) {
      void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
    }
    setIsLoading(false);
  };

  const failure = result && !result.ok ? reason(result.code) : '';
  const detail = result && !result.ok && result.message ? `${failure}: ${result.message}` : failure;

  return (
    <div className="inline-flex items-center gap-1.5">
      {slot ? (
        <>
          <span dir="ltr" className="font-mono text-[11px]">#{slot.position + 1} ••••{slot.last4}</span>
          <input
            type="text"
            dir="ltr"
            aria-label={`${t('testModelLabel')} (${provider}, #${slot.position + 1})`}
            placeholder={t('testModelAuto')}
            value={selectedModel}
            maxLength={200}
            disabled={disabled || isLoading}
            onChange={(event) => { setSelectedModel(event.target.value); setResult(null); }}
            className="w-28 rounded-lg border border-ink-300 dark:border-ink-700 bg-transparent px-2 py-1 text-[11px]"
          />
        </>
      ) : (
        <select
          aria-label={`${t('testModelLabel')} (${provider})`}
          value={selectedModel}
          disabled={disabled || isLoading}
          onFocus={() => setWantModels(true)}
          onMouseDown={() => setWantModels(true)}
          onChange={(e) => {
            setSelectedModel(e.target.value);
            setResult(null);
          }}
          className="px-2 py-1 text-[11px] rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 max-w-[130px] truncate focus:ring-1 focus:ring-brand-500 focus:outline-hidden disabled:opacity-50"
        >
          <option value="">{t('testModelAuto')}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        disabled={disabled || isLoading}
        onClick={() => void handleTest()}
        title={t('testKeyAction')}
        aria-label={slot
          ? `${t('testKeyAction')} (${provider}, #${slot.position + 1}, ••••${slot.last4})`
          : `${t('testKeyAction')} (${provider})`}
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
              title={
                result.model
                  ? `${t('testKeySuccess', { ms: String(result.ms ?? 0) })} (${result.model})`
                  : t('testKeySuccess', { ms: String(result.ms ?? 0) })
              }
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

export function ProviderTestButtons({ workspaceId, provider, slots }: {
  workspaceId: string;
  provider: ApiProvider;
  slots?: readonly KeySlotItem[] | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <TestKeyButton workspaceId={workspaceId} provider={provider} />
      {slots?.map((slot) => (
        <TestKeyButton key={slot.id} workspaceId={workspaceId} provider={provider} slot={slot} />
      ))}
    </div>
  );
}
