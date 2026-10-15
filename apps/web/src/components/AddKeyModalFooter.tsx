import { CheckCircle2, XCircle } from 'lucide-react';
import type { TestConnectionResponse } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import type { KeyField } from './add-key-modal-utils.js';

export function AddKeyModalFooter({
  workspaceId,
  multi,
  isTesting,
  isPending,
  apiKeyInput,
  fields,
  testResult,
  onTestBeforeSave,
  onClose,
  testReason,
}: {
  workspaceId?: string | undefined;
  multi: boolean;
  isTesting: boolean;
  isPending: boolean;
  apiKeyInput: string;
  fields: KeyField[];
  testResult: TestConnectionResponse | null;
  onTestBeforeSave: () => void;
  onClose: () => void;
  testReason: (code: string | undefined) => string;
}) {
  const { t } = useI18n();
  return (
    <>
      {/* Test Result Banner */}
      {testResult && (
        <div
          role="status"
          className={`p-2.5 rounded-xl text-xs flex items-center gap-2 ${
            testResult.ok
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
              : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span title={testResult.ok ? undefined : testResult.message}>
            {testResult.ok
              ? t('testKeySuccess', { ms: String(testResult.ms ?? 0) })
              : t('testKeyFailed', { reason: testReason(testResult.code) })}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2.5 mt-3">
        {workspaceId && !multi ? (
          <button
            type="button"
            disabled={isTesting || isPending || apiKeyInput.length < 8}
            onClick={onTestBeforeSave}
            className="px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {isTesting && (
              <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
            )}
            {isTesting ? t('testingKey') : t('testBeforeSave')}
          </button>
        ) : (
          <div />
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={
              isPending ||
              isTesting ||
              fields.some((field) => field.testing) ||
              (multi ? fields.some((field) => !field.value.trim()) : !apiKeyInput.trim())
            }
            className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          >
            {isPending ? t('savingKey') : t('saveKeyButton')}
          </button>
        </div>
      </div>
    </>
  );
}
