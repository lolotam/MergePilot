import { useEffect, useState } from 'react';
import type {
  WebScanCreateSiteRequest,
  WebScanSchedule,
  WebScanSiteDto,
  WebScanUpdateSiteRequest,
} from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { formatDateTime } from '../format.js';
import { Pager, TableCard, tbodyClass, tdClass, thClass, theadClass } from '../ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SiteForm, type SiteFormPayload } from './SiteForm.js';
import { SourceBadge } from './components.js';
import {
  WEB_SCAN_SITES_PAGE_SIZE,
  isPermissionLost,
  useWebScanCreateSiteMutation,
  useWebScanDeleteSiteMutation,
  useWebScanSettingsQuery,
  useWebScanSitesQuery,
  useWebScanUpdateSiteMutation,
} from './hooks.js';
import { useWebScanRights } from './rights.js';
import { SCHEDULE_FREQUENCY_KEYS, scheduleTime } from './schedule-labels.js';
import { EmptyState, ErrorState, LoadingState, PermissionLostState } from './states.js';

/** The form of the panel: a new site, or the site being edited. */
type OpenForm = { mode: 'create' } | { mode: 'edit'; site: WebScanSiteDto };

/**
 * The registered sites (ADR-0052 section 12).
 *
 * The list shows the effective schedule of every site and where it comes from:
 * the global default, or a rule that is set for this site. The global policy
 * is a dependency of the list and of the form: the form starts from the rule
 * that is in force, so it is never opened before the policy is there.
 */
export function SitesPanel() {
  const { t, language } = useI18n();
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, error } = useWebScanSitesQuery(offset);
  const settings = useWebScanSettingsQuery();
  const rights = useWebScanRights();
  const create = useWebScanCreateSiteMutation();
  const update = useWebScanUpdateSiteMutation();
  const remove = useWebScanDeleteSiteMutation();
  const [form, setForm] = useState<OpenForm | null>(null);
  const [removal, setRemoval] = useState<WebScanSiteDto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);

  const globalSchedule = settings.data?.defaultSchedule;

  const save = (payload: SiteFormPayload) => {
    setFormError(null);
    if (form?.mode === 'edit') {
      const body: WebScanUpdateSiteRequest = {};
      if (payload.scope !== undefined) body.scope = payload.scope;
      if (payload.schedule !== undefined && payload.schedule !== null) body.schedule = payload.schedule;
      if (payload.authorize) body.authorize = true;
      // Nothing changed: the site keeps its rows and its audit stays clean.
      if (Object.keys(body).length === 0) {
        setForm(null);
        return;
      }
      update.mutate(
        { siteId: form.site.id, body },
        {
          onSuccess: () => setForm(null),
          onError: (err: Error) => {
            if (rights.report(err)) return;
            setFormError(err.message);
          },
        },
      );
      return;
    }
    const body: WebScanCreateSiteRequest = {
      hostname: payload.hostname,
      baseUrl: payload.baseUrl,
      scope: payload.scope ?? {
        crawlPaths: [],
        blockedPaths: [],
        parameterizedPaths: [],
        activePaths: [],
        extraFilePaths: [],
      },
      schedule: payload.schedule ?? null,
      authorize: true,
    };
    create.mutate(body, {
      onSuccess: () => setForm(null),
      onError: (err: Error) => {
        if (rights.report(err)) return;
        setFormError(err.message);
      },
    });
  };

  /**
   * Removes the site the administrator confirmed.
   *
   * The dialog stays open when the removal fails: the site is still there,
   * and the administrator has to see that nothing happened.
   */
  const removeSite = () => {
    if (!removal) return;
    const target = removal;
    setRemovalError(null);
    remove.mutate(target.id, {
      onSuccess: () => setRemoval(null),
      onError: (err: Error) => {
        if (rights.report(err)) return;
        setRemovalError(t('webscanSiteRemoveFailed'));
      },
    });
  };

  const scheduleText = (schedule: WebScanSchedule): string => {
    const base = `${t(SCHEDULE_FREQUENCY_KEYS[schedule.frequency])} · ${scheduleTime(schedule)}`;
    return schedule.enabled ? base : `${base} · ${t('webscanScheduleOff')}`;
  };

  const sites = data?.sites ?? [];
  const limit = data?.limit ?? WEB_SCAN_SITES_PAGE_SIZE;

  // A page that is empty is the end of the list: the administrator goes back
  // to the page before it, so the pager never disappears under an empty page.
  useEffect(() => {
    if (isLoading || isError) return;
    // Only the answer of the page that is asked for counts: while a new page loads, the
    // previous answer stays on screen and says nothing about the page after it.
    if (data?.offset === offset && sites.length === 0 && offset > 0) {
      setOffset(Math.max(offset - limit, 0));
    }
  }, [data?.offset, isLoading, isError, sites.length, offset, limit]);

  let body;
  if (isLoading) body = <LoadingState />;
  else if (isError) body = isPermissionLost(error) ? <PermissionLostState /> : <ErrorState />;
  else if (sites.length === 0) body = <EmptyState>{t('webscanEmptySites')}</EmptyState>;
  else {
    body = (
      <table className="w-full text-start text-xs">
        <thead className={theadClass}>
          <tr>
            <th className={thClass}>{t('webscanColHostname')}</th>
            <th className={thClass}>{t('webscanColBaseUrl')}</th>
            <th className={thClass}>{t('webscanColSchedule')}</th>
            <th className={thClass}>{t('webscanColLastScan')}</th>
            <th className={thClass}>{t('webscanColNextRun')}</th>
            <th className={thClass}>{t('webscanColRepository')}</th>
            <th className={thClass}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {sites.map((site) => {
            const inherited = site.schedule === null ? (globalSchedule ?? null) : null;
            return (
              <tr key={site.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 transition-colors">
                <td className={`${tdClass} font-semibold text-ink-900 dark:text-ink-100`} dir="ltr">
                  {site.hostname}
                </td>
                <td className={`${tdClass} text-ink-500 dark:text-ink-400`} dir="ltr">
                  {site.baseUrl}
                </td>
                <td className={tdClass}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="whitespace-nowrap">
                      {site.schedule !== null
                        ? scheduleText(site.schedule)
                        : inherited !== null
                          ? scheduleText(inherited)
                          : t('webscanNoSchedule')}
                    </span>
                    <SourceBadge source={site.schedule === null ? 'global' : 'site'} />
                  </div>
                </td>
                <td className={`${tdClass} whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                  {formatDateTime(site.lastScanAt, language)}
                </td>
                <td className={`${tdClass} whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                  {formatDateTime(site.nextRunAt, language)}
                </td>
                <td className={`${tdClass} text-ink-500 dark:text-ink-400`} dir="ltr">
                  {site.repository ? `${site.repository.owner}/${site.repository.name}` : '—'}
                </td>
                <td className={`${tdClass} text-end whitespace-nowrap`}>
                  <button
                    type="button"
                    aria-label={`${t('webscanEditSite')}: ${site.hostname}`}
                    onClick={() => {
                      setFormError(null);
                      setForm({ mode: 'edit', site });
                    }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
                  >
                    {t('webscanEditSite')}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('webscanRemoveSite')}: ${site.hostname}`}
                    onClick={() => {
                      setRemovalError(null);
                      setRemoval(site);
                    }}
                    className="ms-2 px-3 py-1.5 text-xs font-semibold rounded-full border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                  >
                    {t('webscanRemoveSite')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  if (rights.lost) return <PermissionLostState />;
  // The global policy decides the schedule every site inherits, so the list
  // and the form wait for it: an inherited rule that is not there yet would
  // look like a rule that does not exist.
  if (settings.isError) {
    return isPermissionLost(settings.error) ? <PermissionLostState /> : <ErrorState />;
  }
  if (settings.isLoading) return <LoadingState />;
  // The global policy decides the schedule every site inherits, so the list
  // and the form wait for it: an inherited rule that is not there yet would
  // look like a rule that does not exist.


  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-bold tracking-tight text-ink-900 dark:text-ink-100">
            {t('webscanSitesTitle')}
          </h2>
          <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{t('webscanSitesDesc')}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setForm({ mode: 'create' });
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors"
        >
          {t('webscanAddSite')}
        </button>
      </div>

      {form && (
        <SiteForm
          // The form keeps the fields of the site it was opened for: the key
          // makes it a new form when another site is opened.
          key={form.mode === 'edit' ? `edit:${form.site.id}` : 'create'}
          mode={form.mode}
          site={form.mode === 'edit' ? form.site : undefined}
          globalSchedule={globalSchedule}
          onSubmit={save}
          onCancel={() => {
            setFormError(null);
            setForm(null);
          }}
          isPending={create.isPending || update.isPending}
          error={formError ?? undefined}
        />
      )}

      <TableCard footer={<Pager page={data} onChange={setOffset} />}>{body}</TableCard>

      <ConfirmDialog
        isOpen={removal !== null}
        title={t('webscanRemoveSiteTitle')}
        description={removal ? `${removal.hostname} — ${t('webscanRemoveSiteDesc')}` : ''}
        confirmLabel={t('webscanRemoveSite')}
        isPending={remove.isPending}
        onClose={() => {
          setRemovalError(null);
          setRemoval(null);
        }}
        onConfirm={removeSite}
      >
        {removalError && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {removalError}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
