import { useId, useState, type FormEvent } from 'react';
import type { WebScanCreateExceptionRequest, WebScanOccurrenceDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { FieldLabel, inputClass } from './components.js';
import { EXCEPTION_CATEGORY_KEYS, EXCEPTION_KIND_KEYS, SEVERITY_KEYS } from './labels.js';

/**
 * The form of one administrator resolution (ADR-0052 section 9).
 *
 * The reason category is a bounded value of the contract, and the free-form
 * reason stays in the dashboard: it is never published to GitHub and never
 * leaves the area.
 */
export interface ExceptionFormProps {
  /** The findings of the site that can be resolved. */
  occurrences: WebScanOccurrenceDto[];
  isPending?: boolean;
  /** The safe message the server answered with. */
  error?: string | undefined;
  onSubmit: (body: WebScanCreateExceptionRequest) => void;
  onCancel: () => void;
}

/** The categories of the contract, in the order of the dictionary. */
const CATEGORIES = [
  'not_applicable',
  'already_mitigated',
  'accepted_risk',
  'out_of_scope',
  'third_party_dependency',
  'test_environment',
] as const satisfies readonly WebScanCreateExceptionRequest['reasonCategory'][];

/** The errors of the two mandatory fields of the form. */
interface FieldErrors {
  occurrence?: string | undefined;
  reason?: string | undefined;
}

/**
 * The ids a control describes: its hint, and its error only when there is one.
 *
 * An id of an error that is not shown describes nothing, so it is left out.
 */
function describedBy(fieldId: string, error: string | undefined): string {
  return error === undefined ? `${fieldId}-hint` : `${fieldId}-hint ${fieldId}-error`;
}

export function ExceptionForm({
  occurrences,
  isPending = false,
  error,
  onSubmit,
  onCancel,
}: ExceptionFormProps) {
  const { t } = useI18n();
  const occurrenceId = useId();
  const kindId = useId();
  const categoryId = useId();
  const reasonId = useId();
  const expiryId = useId();

  const [occurrenceKey, setOccurrenceKey] = useState('');
  const [kind, setKind] = useState<WebScanCreateExceptionRequest['kind']>('accepted');
  const [category, setCategory] = useState<WebScanCreateExceptionRequest['reasonCategory']>(
    'not_applicable',
  );
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    const occurrence = occurrences.find((entry) => entry.occurrenceKey === occurrenceKey);
    if (!occurrence) nextErrors.occurrence = t('webscanExceptionOccurrenceRequired');
    if (reason.trim() === '') nextErrors.reason = t('webscanExceptionReasonRequired');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !occurrence) return;

    onSubmit({
      occurrenceKey: occurrence.occurrenceKey,
      evidenceHash: occurrence.evidenceHash,
      kind,
      reasonCategory: category,
      reason: reason.trim(),
      expiresAt: expiresAt === '' ? null : endOfDay(expiresAt),
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={t('webscanExceptionCreate')}
      className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5 flex flex-col gap-4"
    >
      <h3 className="text-xs font-bold text-ink-900 dark:text-ink-100">
        {t('webscanExceptionCreate')}
      </h3>

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          htmlFor={occurrenceId}
          hint={t('webscanExceptionOccurrenceHint')}
          hintId={`${occurrenceId}-hint`}
          error={errors.occurrence}
          errorId={`${occurrenceId}-error`}
        >
          {t('webscanExceptionOccurrence')}
        </FieldLabel>
        <select
          id={occurrenceId}
          value={occurrenceKey}
          onChange={(event) => {
            setOccurrenceKey(event.target.value);
            // The administrator fixed the field: its error is gone.
            setErrors((current) => ({ ...current, occurrence: undefined }));
          }}
          aria-required="true"
          aria-invalid={errors.occurrence === undefined ? undefined : true}
          aria-describedby={describedBy(occurrenceId, errors.occurrence)}
          className={inputClass}
        >
          <option value="">{t('webscanExceptionOccurrencePlaceholder')}</option>
          {occurrences.map((occurrence) => (
            <option key={occurrence.occurrenceKey} value={occurrence.occurrenceKey}>
              {`${t(SEVERITY_KEYS[occurrence.severity])} · ${occurrence.safeLocation}`}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldLabel htmlFor={kindId}>{t('webscanExceptionKind')}</FieldLabel>
        <select
          id={kindId}
          value={kind}
          onChange={(event) => setKind(event.target.value as WebScanCreateExceptionRequest['kind'])}
          className={`${inputClass} sm:col-start-2`}
        >
          <option value="accepted">{t(EXCEPTION_KIND_KEYS.accepted)}</option>
          <option value="false_positive">{t(EXCEPTION_KIND_KEYS.false_positive)}</option>
        </select>

        <FieldLabel htmlFor={categoryId}>{t('webscanExceptionCategory')}</FieldLabel>
        <select
          id={categoryId}
          value={category}
          onChange={(event) =>
            setCategory(event.target.value as WebScanCreateExceptionRequest['reasonCategory'])
          }
          className={`${inputClass} sm:col-start-2`}
        >
          {CATEGORIES.map((entry) => (
            <option key={entry} value={entry}>
              {t(EXCEPTION_CATEGORY_KEYS[entry])}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          htmlFor={reasonId}
          hint={t('webscanExceptionReasonHint')}
          hintId={`${reasonId}-hint`}
          error={errors.reason}
          errorId={`${reasonId}-error`}
        >
          {t('webscanExceptionReason')}
        </FieldLabel>
        <textarea
          id={reasonId}
          rows={3}
          value={reason}
          onChange={(event) => {
            const value = event.target.value;
            setReason(value);
            // The administrator fixed the field: its error is gone. A value of
            // spaces only is not a fix: the submission refuses it as well, so
            // the error stays where it is.
            setErrors((current) => ({
              ...current,
              reason: value.trim() === '' ? current.reason : undefined,
            }));
          }}
          aria-required="true"
          aria-invalid={errors.reason === undefined ? undefined : true}
          aria-describedby={describedBy(reasonId, errors.reason)}
          className={`${inputClass} resize-y`}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel
          htmlFor={expiryId}
          hint={t('webscanExceptionExpiryHint')}
          hintId={`${expiryId}-hint`}
        >
          {t('webscanExceptionExpiry')}
        </FieldLabel>
        <input
          id={expiryId}
          type="date"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.target.value)}
          aria-describedby={`${expiryId}-hint`}
          className={`${inputClass} sm:w-56`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
        >
          {isPending ? t('saving') : t('webscanExceptionCreate')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
        >
          {t('cancel')}
        </button>
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400 break-words">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * The end of the day the administrator chose.
 *
 * The expiry is a date, and the resolution ends with that day: the last
 * moment of it, in UTC.
 */
function endOfDay(date: string): string {
  return new Date(`${date}T23:59:59.999Z`).toISOString();
}
