import { useId, useState, type FormEvent } from 'react';
import type { WebScanSchedule, WebScanScopeInput, WebScanSiteDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { FieldLabel, SourceBadge, inputClass } from './components.js';
import { ScheduleFields } from './ScheduleFields.js';
import { FilePathsField, ParameterRulesField, PathRulesField } from './ScopeFields.js';
import { toSchedule, toScheduleDraft, sameSchedule, type ScheduleDraft } from './settings-draft.js';
import {
  emptyScopeDraft,
  scopePathsValid,
  sameScope,
  toScopeDraft,
  toScopeInput,
  type ScopeDraft,
} from './site-scope.js';

/** What the form hands to the panel when the administrator saves. */
export interface SiteFormPayload {
  hostname: string;
  baseUrl: string;
  /** The scope, when it changed. */
  scope: WebScanScopeInput | undefined;
  /** The schedule, when it changed. `null` means a new site without a schedule. */
  schedule: WebScanSchedule | null | undefined;
  /** The fresh authorization of the change. */
  authorize: boolean;
}

export interface SiteFormProps {
  mode: 'create' | 'edit';
  /** The site being edited. */
  site?: WebScanSiteDto | undefined;
  /** The default schedule of the global policy, the source of an inherited rule. */
  globalSchedule?: WebScanSchedule | undefined;
  onSubmit: (payload: SiteFormPayload) => void;
  onCancel: () => void;
  isPending?: boolean;
  /** The safe message the server answered with. */
  error?: string | undefined;
}

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function hostnameValid(value: string): boolean {
  return HOSTNAME_PATTERN.test(value);
}

function baseUrlValid(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * The form of one site (ADR-0052 sections 1, 2 and 5).
 *
 * The scope starts empty, the schedule follows the global default until the
 * administrator sets one for this site, and a registration or a scope or
 * schedule change needs a fresh authorization confirmation.
 */
export function SiteForm({
  mode,
  site,
  globalSchedule,
  onSubmit,
  onCancel,
  isPending = false,
  error,
}: SiteFormProps) {
  const { t } = useI18n();
  const hostnameId = useId();
  const baseUrlId = useId();
  const repositoryOwnerId = useId();
  const repositoryNameId = useId();
  const authorizeId = useId();

  const [hostname, setHostname] = useState(site?.hostname ?? '');
  const [baseUrl, setBaseUrl] = useState(site?.baseUrl ?? '');
  const [scope, setScope] = useState<ScopeDraft>(() =>
    site ? toScopeDraft(site.scope) : emptyScopeDraft(),
  );
  const [schedule, setSchedule] = useState<ScheduleDraft>(() => {
    // The site follows the global default until it has a rule of its own, so
    // the form starts from the rule that is in force and not from an empty
    // one: the switch of an inherited rule shows that rule.
    const base = site?.schedule ?? globalSchedule;
    return base
      ? toScheduleDraft(base)
      : { frequency: 'daily' as const, weekday: 0, dayOfMonth: 1, hour: 0, minute: 0, enabled: false };
  });
  const [authorized, setAuthorized] = useState(false);
  const [errors, setErrors] = useState<{ hostname?: string; baseUrl?: string; path?: string; authorization?: string }>({});

  const scopePayload = (): WebScanScopeInput | undefined => {
    const next = toScopeInput(scope);
    if (mode === 'create' || !site) return next;
    const current = toScopeInput(toScopeDraft(site.scope));
    return sameScope(current, next) ? undefined : next;
  };

  /**
   * The rule the site follows now: the rule of its own, or the global default
   * it inherits.
   */
  const effectiveSchedule = site?.schedule ?? globalSchedule;

  /**
   * The rule the form sends, and nothing when the rule did not change.
   *
   * A rule is never cleared: a rule the site inherits and that the
   * administrator switches off becomes a rule of the site's own with
   * `enabled: false`, so the site stops following the global default.
   */
  const schedulePayload = (): WebScanSchedule | null | undefined => {
    const next = toSchedule(schedule);
    if (effectiveSchedule === undefined) {
      // There is no rule to follow: a new site asks for the global one, and
      // an existing site keeps the rule it has.
      if (mode === 'create') return schedule.enabled ? next : null;
      return undefined;
    }
    if (sameSchedule(effectiveSchedule, next)) {
      // The site already follows this rule, so nothing is sent.
      return mode === 'create' ? null : undefined;
    }
    return next;
  };

  const needsAuthorization = mode === 'create' || scopePayload() !== undefined || schedulePayload() !== undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    if (mode === 'create') {
      if (hostname.trim() === '') nextErrors.hostname = t('webscanRequiredField');
      else if (!hostnameValid(hostname.trim())) nextErrors.hostname = t('webscanInvalidHostname');
      if (baseUrl.trim() === '') nextErrors.baseUrl = t('webscanRequiredField');
      else if (!baseUrlValid(baseUrl.trim())) nextErrors.baseUrl = t('webscanInvalidBaseUrl');
    }
    if (!scopePathsValid(scope)) nextErrors.path = t('webscanInvalidPath');
    if (needsAuthorization && !authorized) nextErrors.authorization = t('webscanAuthorizationRequired');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    onSubmit({
      hostname: hostname.trim(),
      baseUrl: baseUrl.trim(),
      scope: scopePayload(),
      schedule: schedulePayload(),
      authorize: needsAuthorization,
    });
  };

  const scheduleSource = site?.schedule ? 'site' : 'global';

  return (
    <form
      onSubmit={submit}
      aria-label={mode === 'create' ? t('webscanFormAddTitle') : t('webscanFormEditTitle')}
      className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-bold text-ink-900 dark:text-ink-100">
          {mode === 'create' ? t('webscanFormAddTitle') : t('webscanFormEditTitle')}
        </h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldLabel
          htmlFor={hostnameId}
          hint={t('webscanHostnameHint')}
          hintId={`${hostnameId}-hint`}
          error={errors.hostname}
          errorId={`${hostnameId}-error`}
        >
          {t('webscanHostnameLabel')}
        </FieldLabel>
        <input
          id={hostnameId}
          type="text"
          dir="ltr"
          value={hostname}
          readOnly={mode === 'edit'}
          onChange={(e) => setHostname(e.target.value)}
          aria-describedby={`${hostnameId}-hint ${hostnameId}-error`}
          className={`${inputClass} sm:col-start-2`}
        />

        <FieldLabel
          htmlFor={baseUrlId}
          hint={t('webscanBaseUrlHint')}
          hintId={`${baseUrlId}-hint`}
          error={errors.baseUrl}
          errorId={`${baseUrlId}-error`}
        >
          {t('webscanBaseUrlLabel')}
        </FieldLabel>
        <input
          id={baseUrlId}
          type="text"
          dir="ltr"
          value={baseUrl}
          readOnly={mode === 'edit'}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-describedby={`${baseUrlId}-hint ${baseUrlId}-error`}
          className={`${inputClass} sm:col-start-2`}
        />

        <FieldLabel
          htmlFor={repositoryOwnerId}
          hint={t('webscanRepositoryHint')}
          hintId={`${repositoryOwnerId}-hint`}
        >
          {t('webscanRepositoryLabel')}
        </FieldLabel>
        <div className="flex flex-wrap items-center gap-2 sm:col-start-2">
          <input
            id={repositoryOwnerId}
            type="text"
            dir="ltr"
            value={site?.repository?.owner ?? ''}
            readOnly
            aria-describedby={`${repositoryOwnerId}-hint`}
            className={`${inputClass} w-40`}
          />
          <input
            id={repositoryNameId}
            type="text"
            dir="ltr"
            value={site?.repository?.name ?? ''}
            readOnly
            aria-label={t('webscanColRepository')}
            className={`${inputClass} w-40`}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold text-ink-800 dark:text-ink-100">
          {t('webscanScheduleSection')}
        </legend>
        <div className="flex items-center gap-2">
          <SourceBadge source={scheduleSource} />
          <span className="text-[11px] text-ink-500 dark:text-ink-400">{t('webscanScheduleKuwait')}</span>
        </div>
        <ScheduleFields schedule={schedule} onChange={setSchedule} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-xs font-semibold text-ink-800 dark:text-ink-100">
          {t('webscanScopeSection')}
        </legend>
        <div className="flex items-center gap-2">
          <SourceBadge source="site" />
          <p className="text-[11px] text-ink-500 dark:text-ink-400">{t('webscanScopeEmptyNote')}</p>
        </div>
        <PathRulesField
          label={t('webscanCrawlPathsLabel')}
          rules={scope.crawlPaths}
          onChange={(crawlPaths) => setScope({ ...scope, crawlPaths })}
        />
        <PathRulesField
          label={t('webscanBlockedPathsLabel')}
          rules={scope.blockedPaths}
          onChange={(blockedPaths) => setScope({ ...scope, blockedPaths })}
        />
        <ParameterRulesField
          label={t('webscanParameterizedPathsLabel')}
          rules={scope.parameterizedPaths}
          onChange={(parameterizedPaths) => setScope({ ...scope, parameterizedPaths })}
        />
        <ParameterRulesField
          label={t('webscanActivePathsLabel')}
          rules={scope.activePaths}
          onChange={(activePaths) => setScope({ ...scope, activePaths })}
        />
        <FilePathsField
          label={t('webscanExtraFilePathsLabel')}
          paths={scope.extraFilePaths}
          onChange={(extraFilePaths) => setScope({ ...scope, extraFilePaths })}
        />
        {errors.path && (
          <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
            {errors.path}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <input
            id={authorizeId}
            type="checkbox"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
            aria-describedby={`${authorizeId}-notice ${authorizeId}-error`}
            className="mt-0.5 w-4 h-4 rounded border-ink-300 dark:border-ink-700 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          />
          <label htmlFor={authorizeId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanAuthorizationLabel')}
          </label>
        </div>
        <p id={`${authorizeId}-notice`} className="text-[11px] text-ink-500 dark:text-ink-400 ms-6">
          {t('webscanGetOnlyNotice')}
        </p>
        {errors.authorization && (
          <p id={`${authorizeId}-error`} role="alert" className="text-[11px] text-red-600 dark:text-red-400 ms-6">
            {errors.authorization}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
        >
          {isPending ? t('saving') : t('webscanSaveSite')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
        >
          {mode === 'create' ? t('cancel') : t('webscanCancelEdit')}
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
