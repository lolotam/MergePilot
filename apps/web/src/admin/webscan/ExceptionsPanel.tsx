import { useState } from 'react';
import type { WebScanCreateExceptionRequest, WebScanExceptionDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { formatDateTime } from '../format.js';
import { Badge, TableCard, tbodyClass, tdClass, thClass, theadClass } from '../ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ExceptionForm } from './ExceptionForm.js';
import { SiteSelect } from './SiteSelect.js';
import {
  isPermissionLost,
  useWebScanCreateExceptionMutation,
  useWebScanDeleteExceptionMutation,
  useWebScanExceptionsQuery,
  useWebScanScanQuery,
  useWebScanSiteOptionsQuery,
} from './hooks.js';
import { EXCEPTION_CATEGORY_KEYS, EXCEPTION_KIND_KEYS } from './labels.js';
import { useWebScanSelection } from './selection.js';
import { EmptyState, ErrorState, LoadingState, PermissionLostState } from './states.js';

/**
 * The resolutions of the administrator (ADR-0052 sections 9 and 12).
 *
 * A resolution covers one finding while its identity and its evidence match.
 * Revoking it brings the finding it covered back to the outstanding findings,
 * so the revocation asks for a confirmation that says so.
 */
export function ExceptionsPanel() {
  const { t, language } = useI18n();
  const { siteId, setSiteId } = useWebScanSelection();
  const sites = useWebScanSiteOptionsQuery();
  const exceptions = useWebScanExceptionsQuery(siteId);
  const create = useWebScanCreateExceptionMutation();
  const revoke = useWebScanDeleteExceptionMutation();
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<WebScanExceptionDto | null>(null);
  const [lostRights, setLostRights] = useState(false);

  const site = sites.data?.sites.find((entry) => entry.id === siteId);
  // The ledger of the site is the list of the findings that can be resolved.
  const ledger = useWebScanScanQuery(site?.lastCoverageScanId ?? undefined);
  const outstanding = (ledger.data?.occurrences ?? []).filter(
    (occurrence) => occurrence.state === 'outstanding',
  );

  const lost = [sites.error, exceptions.error, ledger.error].some((error) =>
    isPermissionLost(error),
  );
  if (lost || lostRights) return <PermissionLostState />;
  if (sites.isError) return <ErrorState />;
  if (sites.isLoading) return <LoadingState />;

  const selectSite = (nextSiteId: string) => {
    setSiteId(nextSiteId);
    setFormOpen(false);
    setFormError(null);
    setRemoval(null);
  };

  const save = (body: WebScanCreateExceptionRequest) => {
    if (!siteId) return;
    setFormError(null);
    create.mutate(
      { siteId, body },
      {
        onSuccess: () => setFormOpen(false),
        onError: (error: Error) => {
          if (isPermissionLost(error)) {
            setLostRights(true);
            return;
          }
          setFormError(t('webscanExceptionCreateFailed'));
        },
      },
    );
  };

  const listed = exceptions.data?.exceptions ?? [];
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-serif text-lg font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('webscanExceptionsTitle')}
        </h2>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">
          {t('webscanExceptionsDesc')}
        </p>
      </header>

      <SiteSelect sites={sites.data?.sites ?? []} value={siteId} onChange={selectSite} />

      {siteId === undefined ? (
        <EmptyState>
          {(sites.data?.sites.length ?? 0) === 0
            ? t('webscanNoSitesToScan')
            : t('webscanChooseSiteToScan')}
        </EmptyState>
      ) : (
        <>
          {formOpen ? (
            <ExceptionForm
              occurrences={outstanding}
              isPending={create.isPending}
              error={formError ?? undefined}
              onSubmit={save}
              onCancel={() => {
                setFormOpen(false);
                setFormError(null);
              }}
            />
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setFormOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors"
              >
                {t('webscanExceptionCreate')}
              </button>
            </div>
          )}

          {exceptions.isError ? (
            <ErrorState />
          ) : exceptions.isLoading ? (
            <LoadingState />
          ) : listed.length === 0 ? (
            <EmptyState>{t('webscanEmptyExceptions')}</EmptyState>
          ) : (
            <TableCard>
              <table className="w-full text-start text-xs">
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>{t('webscanExceptionKind')}</th>
                    <th className={thClass}>{t('webscanExceptionCategory')}</th>
                    <th className={thClass}>{t('webscanExceptionReason')}</th>
                    <th className={thClass}>{t('webscanExceptionExpiry')}</th>
                    <th className={thClass}>{t('webscanColState')}</th>
                    <th className={thClass}>
                      <span className="sr-only">{t('actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className={tbodyClass}>
                  {listed.map((exception) => {
                    const state = stateOf(exception, now);
                    return (
                      <tr key={exception.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40">
                        <td className={tdClass}>{t(EXCEPTION_KIND_KEYS[exception.kind])}</td>
                        <td className={tdClass}>{t(EXCEPTION_CATEGORY_KEYS[exception.reasonCategory])}</td>
                        <td className={`${tdClass} break-words text-ink-600 dark:text-ink-300`}>
                          {exception.reason}
                        </td>
                        <td className={`${tdClass} whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                          {exception.expiresAt === null
                            ? t('webscanExceptionNoExpiry')
                            : formatDateTime(exception.expiresAt, language)}
                        </td>
                        <td className={tdClass}>
                          <Badge
                            tone={
                              state === 'active' ? 'success' : state === 'expired' ? 'warning' : 'neutral'
                            }
                          >
                            {t(
                              state === 'active'
                                ? 'webscanExceptionStateActive'
                                : state === 'expired'
                                  ? 'webscanExceptionStateExpired'
                                  : 'webscanExceptionStateRevoked',
                            )}
                          </Badge>
                        </td>
                        <td className={`${tdClass} text-end whitespace-nowrap`}>
                          {state === 'active' && (
                            <button
                              type="button"
                              aria-label={`${t('webscanExceptionRevoke')}: ${exception.id}`}
                              onClick={() => setRemoval(exception)}
                              className="px-3 py-1.5 text-xs font-semibold rounded-full border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                            >
                              {t('webscanExceptionRevoke')}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableCard>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={removal !== null}
        title={t('webscanExceptionRevokeTitle')}
        description={t('webscanExceptionRevokeDesc')}
        confirmLabel={t('webscanExceptionRevoke')}
        isPending={revoke.isPending}
        onClose={() => setRemoval(null)}
        onConfirm={() => {
          if (!removal || !siteId) return;
          const target = removal;
          revoke.mutate(
            { siteId, exceptionId: target.id },
            {
              onError: (error: Error) => {
                if (isPermissionLost(error)) setLostRights(true);
              },
              onSettled: () => setRemoval(null),
            },
          );
        }}
      />
    </div>
  );
}

/** The state of a resolution: revoked, ended or still in force. */
function stateOf(exception: WebScanExceptionDto, now: number): 'active' | 'expired' | 'revoked' {
  if (exception.revokedAt !== null) return 'revoked';
  if (exception.expiresAt !== null && new Date(exception.expiresAt).getTime() <= now) {
    return 'expired';
  }
  return 'active';
}
