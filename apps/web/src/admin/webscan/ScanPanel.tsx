import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { FindingsPanel } from './FindingsPanel.js';
import { ScanHistory } from './ScanHistory.js';
import { ScanStatus } from './ScanStatus.js';
import { SiteSelect } from './SiteSelect.js';
import {
  WEB_SCAN_SCANS_PAGE_SIZE,
  isConclusiveRefusal,
  isPermissionLost,
  useWebScanEnqueueMutation,
  useWebScanExceptionsQuery,
  useWebScanScanQuery,
  useWebScanScansQuery,
  useWebScanSiteOptionsQuery,
  useWebScanStopMutation,
} from './hooks.js';
import { useWebScanRights } from './rights.js';
import { useScanEvents, type ScanProgress } from './scan-events.js';
import { newScanIdempotencyKey } from './scan-intent.js';
import { useWebScanSelection } from './selection.js';
import { EmptyState, ErrorState, LoadingState, PermissionLostState } from './states.js';

/**
 * The scan panel of the area (ADR-0052 sections 6, 7 and 12).
 *
 * A manual scan is an authorization act: it needs the fresh confirmation of
 * the ownership every time, and it carries an idempotency key that belongs to
 * the start intent. A retry of a request the server never accepted reuses the
 * key, so the server replays its scan instead of queueing a second one.
 *
 * The confirmation and the key belong to one site: another site is another
 * target, so they are dropped when the site changes.
 */
export function ScanPanel() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { siteId, setSiteId } = useWebScanSelection();
  const rights = useWebScanRights();
  const authorizationId = useId();
  const sites = useWebScanSiteOptionsQuery();
  const [offset, setOffset] = useState(0);
  const [authorized, setAuthorized] = useState(false);
  const [scanId, setScanId] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const intentKey = useRef<string | null>(null);
  const enqueue = useWebScanEnqueueMutation();
  const stop = useWebScanStopMutation();
  const history = useWebScanScansQuery(siteId, offset);
  const scan = useWebScanScanQuery(scanId);
  const exceptions = useWebScanExceptionsQuery(scan.data?.scan.siteId);
  useScanEvents(scanId, setProgress);

  // The site the panel works on right now: the answer of a request that
  // belongs to another site is never installed. The ref follows the site in
  // an effect and never in the render body, so a render that React replays
  // or discards never moves it.
  const currentSiteId = useRef(siteId);
  useLayoutEffect(() => {
    currentSiteId.current = siteId;
  }, [siteId]);

  // Another site is another target: the confirmation of one site never
  // authorizes another one, the key of one intent never starts another one,
  // and the scan of the previous site is never shown under the new one.
  const resetTarget = () => {
    setAuthorized(false);
    intentKey.current = null;
    setScanId(undefined);
    setProgress(null);
  };

  useEffect(() => {
    resetTarget();
  }, [siteId]);

  // A 404 of the area means the session lost its platform-admin rights.
  const lost = [sites.error, history.error, scan.error, exceptions.error].some((error) =>
    isPermissionLost(error),
  );
  if (lost || rights.lost) return <PermissionLostState />;
  if (sites.isError) return <ErrorState />;
  if (sites.isLoading) return <LoadingState />;

  const selectSite = (nextSiteId: string) => {
    setSiteId(nextSiteId);
    setOffset(0);
    setMessage(null);
    resetTarget();
  };

  const start = () => {
    if (!siteId || !authorized) return;
    setMessage(null);
    // The key belongs to the intent: a retry of a request the server never
    // accepted sends the same key again.
    const key = intentKey.current ?? newScanIdempotencyKey();
    intentKey.current = key;
    // The confirmation belongs to one start: the next one needs it again.
    setAuthorized(false);
    enqueue.mutate(
      { siteId, body: { idempotencyKey: key, authorize: true } },
      {
        onSuccess: (result) => {
          // The administrator moved to another site while the request was on
          // its way: the answer belongs to the site they left, so it is
          // dropped instead of opening the scan of that site here.
          if (currentSiteId.current !== siteId) return;
          intentKey.current = null;
          setScanId(result.scan.id);
          setProgress(null);
          showToast(t('webscanScanStarted'), 'success');
        },
        onError: (error: Error) => {
          if (rights.report(error)) return;
          // A refusal is conclusive: the next start is a new intent.
          if (isConclusiveRefusal(error)) intentKey.current = null;
          setMessage(t('webscanScanStartFailed'));
        },
      },
    );
  };

  const stopScan = () => {
    if (!scanId) return;
    setMessage(null);
    stop.mutate(scanId, {
      onError: (error: Error) => {
        if (rights.report(error)) return;
        setMessage(t('webscanScanStopFailed'));
      },
    });
  };

  const scans = history.data?.scans ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-serif text-lg font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('webscanScansTitle')}
        </h2>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{t('webscanScansDesc')}</p>
      </header>

      <SiteSelect
        sites={sites.data?.sites ?? []}
        value={siteId}
        onChange={selectSite}
        // The site of a request that is on its way may not change: the answer
        // of that request would belong to a site the panel no longer shows.
        disabled={enqueue.isPending}
      />

      {siteId === undefined ? (
        <EmptyState>
          {(sites.data?.sites.length ?? 0) === 0
            ? t('webscanNoSitesToScan')
            : t('webscanChooseSiteToScan')}
        </EmptyState>
      ) : (
        <div className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5 flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <input
              id={authorizationId}
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
              aria-describedby={`${authorizationId}-notice`}
              className="mt-0.5 w-4 h-4 rounded border-ink-300 dark:border-ink-700 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            />
            <label
              htmlFor={authorizationId}
              className="text-xs font-semibold text-ink-800 dark:text-ink-100"
            >
              {t('webscanAuthorizationLabel')}
            </label>
          </div>
          <p id={`${authorizationId}-notice`} className="text-[11px] text-ink-500 dark:text-ink-400 ms-6">
            {t('webscanGetOnlyNotice')}
          </p>
          <div>
            <button
              type="button"
              onClick={start}
              disabled={!authorized || enqueue.isPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
            >
              {enqueue.isPending ? t('loading') : t('webscanStartScan')}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      )}

      {scan.isError ? (
        <ErrorState />
      ) : (
        scan.data && (
          <>
            <ScanStatus
              scan={scan.data.scan}
              progress={progress}
              isStopping={stop.isPending}
              onStop={stopScan}
            />
            {exceptions.isError ? (
              <ErrorState />
            ) : (
              <FindingsPanel
                detail={scan.data}
                exceptions={exceptions.data?.exceptions ?? []}
                onPermissionLost={(error) => {
                  rights.report(error);
                }}
              />
            )}
          </>
        )
      )}

      {siteId !== undefined && (
        <>
          <h3 className="text-xs font-bold text-ink-900 dark:text-ink-100">
            {t('webscanScanHistory')}
          </h3>
          {history.isError ? (
            <ErrorState />
          ) : history.isLoading ? (
            <LoadingState />
          ) : scans.length === 0 && offset === 0 ? (
            <EmptyState>{t('webscanEmptyScans')}</EmptyState>
          ) : (
            // A page that is empty but not the first one still shows the
            // history: the pager is the way back to the pages before it.
            <ScanHistory
              scans={scans}
              limit={history.data?.limit ?? WEB_SCAN_SCANS_PAGE_SIZE}
              offset={offset}
              selectedScanId={scanId}
              onChangeOffset={setOffset}
              onSelect={(id) => {
                setScanId(id);
                setProgress(null);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
