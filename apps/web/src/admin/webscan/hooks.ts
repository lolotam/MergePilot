import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WebScanCreateExceptionRequest,
  WebScanCreateSiteRequest,
  WebScanEnqueueManualRequest,
  WebScanLimitField,
  WebScanSettingsPatchRequest,
  WebScanSiteDto,
  WebScanUpdateSiteRequest,
} from '@mergepilot/app/contract';
import { ApiClientError } from '../../api/client.js';
import { webScanApi } from '../../api/webscan.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { WEB_SCAN_LIMIT_ROWS } from './limit-rows.js';

/** The page size of the sites list. */
export const WEB_SCAN_SITES_PAGE_SIZE = 25;
/** The page size of the scan history. */
export const WEB_SCAN_SCANS_PAGE_SIZE = 20;
/** The page size of the audit log. */
export const WEB_SCAN_AUDIT_PAGE_SIZE = 25;
/** How many sites the picker of the scan panels asks for in one page. */
export const WEB_SCAN_SITE_OPTIONS_LIMIT = 100;

/**
 * A 404 from the scanner API means the session lost its platform-admin rights:
 * every route of the area answers the regular 404 to everyone else. It never
 * means that a row is missing, so the panels show the permission-lost state
 * instead of a retry.
 */
export function isPermissionLost(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 404;
}

/** How many times a failed query of the area is tried again. */
const WEB_SCAN_QUERY_RETRIES = 2;

/** The delay before a failed query of the area is tried again. */
const WEB_SCAN_QUERY_RETRY_DELAY_MS = 200;

/**
 * The retry policy of the queries of the area.
 *
 * A 404 is conclusive: the session lost its admin rights and the request
 * would be refused again, so it is never retried. Every other failure may be
 * transient, so it is tried again at most twice before the panel shows the
 * error instead of stranding the administrator on a broken page.
 */
export function webScanRetry(failureCount: number, error: unknown): boolean {
  if (isPermissionLost(error)) return false;
  return failureCount < WEB_SCAN_QUERY_RETRIES;
}

/**
 * The options every query of the area shares.
 *
 * The delay is short: the area is a dashboard of the server itself, so a
 * hiccup of the network is worth another try at once.
 */
const WEB_SCAN_QUERY_OPTIONS = {
  retry: webScanRetry,
  retryDelay: WEB_SCAN_QUERY_RETRY_DELAY_MS,
} as const;

/** The error code of the second confirmation a value above its default needs. */
export const ABOVE_DEFAULT_CONFIRMATION_CODE = 'confirmation_required';

/** True when the server refused a change because it needs the second confirmation. */
export function needsAboveDefaultConfirmation(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === ABOVE_DEFAULT_CONFIRMATION_CODE;
}

/**
 * The second confirmation of a value above its default, as the server sent it.
 *
 * The server is the only authority of the digest: it binds the confirmation to
 * the effective limits it is about to store, and it hands the digest and the
 * names of the fields that are above their default back with the refusal. The
 * dashboard never computes them itself, so it can never confirm a different
 * set of values than the one the server checks.
 */
export interface AboveDefaultConfirmation {
  /** The digest of the effective limits, sent back unchanged. */
  digest: string;
  /** The limit fields that are above their default. */
  fields: WebScanLimitField[];
}

/** The limit fields the dashboard knows, by name. */
const KNOWN_LIMIT_FIELDS = new Set<string>(WEB_SCAN_LIMIT_ROWS.map((row) => row.field));

/**
 * The confirmation the server sent with its refusal, when it sent a usable one.
 *
 * A refusal without a digest or without the fields is not a confirmation: the
 * panel shows its own error instead of resending a request it cannot build.
 */
export function aboveDefaultConfirmation(error: unknown): AboveDefaultConfirmation | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  if (error.code !== ABOVE_DEFAULT_CONFIRMATION_CODE) return undefined;
  const digest = error.details['digest'];
  const fields = error.details['fieldsAboveDefault'];
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  if (!Array.isArray(fields)) return undefined;
  const parsed: WebScanLimitField[] = [];
  for (const field of fields) {
    if (typeof field !== 'string' || !KNOWN_LIMIT_FIELDS.has(field)) return undefined;
    parsed.push(field as WebScanLimitField);
  }
  return { digest, fields: parsed };
}

/**
 * True when the server answered the request and refused it.
 *
 * A refusal is conclusive: the server knows the request and wrote nothing, so
 * the next start is a new intent. A network failure or a server error is not:
 * the scan may be queued, so the same idempotency key is used again.
 */
export function isConclusiveRefusal(error: unknown): boolean {
  return error instanceof ApiClientError && error.status >= 400 && error.status < 500;
}

export function useWebScanSettingsQuery() {
  return useQuery({
    queryKey: ['webscan', 'settings'],
    queryFn: () => webScanApi.getSettings(),
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}

export function useWebScanUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: WebScanSettingsPatchRequest) => webScanApi.updateSettings(patch),
    onSuccess: (saved) => {
      queryClient.setQueryData(['webscan', 'settings'], saved);
    },
  });
}

export function useWebScanSitesQuery(offset: number) {
  return useQuery({
    queryKey: ['webscan', 'sites', offset],
    queryFn: () => webScanApi.getSites({ limit: WEB_SCAN_SITES_PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}

/**
 * The sites the picker of the scan panels offers.
 *
 * The picker has no search and no paging of its own, so it needs every site:
 * the query walks the pages of the list until the count it collected reaches
 * the total the server reports, so the answer is never a silently partial list.
 * The answer keeps the shape of a page, so the callers read it the same way
 * they read the page of the sites list.
 */
export function useWebScanSiteOptionsQuery() {
  return useQuery({
    queryKey: ['webscan', 'sites', 'options'],
    queryFn: async () => {
      const sites: WebScanSiteDto[] = [];
      let total: number;
      do {
        const answer = await webScanApi.getSites({
          limit: WEB_SCAN_SITE_OPTIONS_LIMIT,
          offset: sites.length,
        });
        total = answer.total;
        sites.push(...answer.sites);
        // An empty page is the end of the list, even before the reported total.
        if (answer.sites.length === 0) break;
      } while (sites.length < total);
      return { sites, total, limit: WEB_SCAN_SITE_OPTIONS_LIMIT, offset: 0 };
    },
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}

function useSiteMutation<TVariables>(
  run: (variables: TVariables) => Promise<unknown>,
  successKey: 'webscanSiteAdded' | 'webscanSiteSaved' | 'webscanSiteRemoved',
) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      showToast(t(successKey), 'success');
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'sites'] });
    },
  });
}

export function useWebScanCreateSiteMutation() {
  return useSiteMutation(
    (body: WebScanCreateSiteRequest) => webScanApi.createSite(body),
    'webscanSiteAdded',
  );
}

export function useWebScanUpdateSiteMutation() {
  return useSiteMutation(
    (input: { siteId: string; body: WebScanUpdateSiteRequest }) =>
      webScanApi.updateSite(input.siteId, input.body),
    'webscanSiteSaved',
  );
}

export function useWebScanDeleteSiteMutation() {
  return useSiteMutation((siteId: string) => webScanApi.deleteSite(siteId), 'webscanSiteRemoved');
}

/** The query key of the state of one scan. */
export function webScanScanKey(scanId: string) {
  return ['webscan', 'scan', scanId] as const;
}

/** The history of the scans of one site. */
export function useWebScanScansQuery(siteId: string | undefined, offset: number) {
  return useQuery({
    queryKey: ['webscan', 'scans', siteId, offset],
    queryFn: () => {
      if (!siteId) throw new Error('The scan history needs a site');
      return webScanApi.getScans(siteId, { limit: WEB_SCAN_SCANS_PAGE_SIZE, offset });
    },
    enabled: siteId !== undefined,
    // The rows of the page before stay while the next one is on its way, but
    // only the rows of the same site: the history of another site is never
    // shown under this one, and it is never clickable there.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === siteId ? previous : undefined,
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}

/** The durable state of one scan: its status, its coverage and its ledger. */
export function useWebScanScanQuery(scanId: string | undefined) {
  return useQuery({
    queryKey: webScanScanKey(scanId ?? ''),
    queryFn: () => {
      if (!scanId) throw new Error('The scan needs an id');
      return webScanApi.getScan(scanId);
    },
    enabled: scanId !== undefined,
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}

/** The enqueue of a manual scan. */
export function useWebScanEnqueueMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { siteId: string; body: WebScanEnqueueManualRequest }) =>
      webScanApi.startManualScan(input.siteId, input.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'scans'] });
    },
  });
}

/** The idempotent cancellation of a queued or running scan. */
export function useWebScanStopMutation() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (scanId: string) => webScanApi.stopScan(scanId),
    onSuccess: (result) => {
      showToast(t('webscanScanStoppedToast'), 'success');
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'scans'] });
      void queryClient.invalidateQueries({ queryKey: webScanScanKey(result.scan.id) });
    },
  });
}

/** The resolutions of one site, the revoked ones included. */
export function useWebScanExceptionsQuery(siteId: string | undefined) {
  return useQuery({
    queryKey: ['webscan', 'exceptions', siteId],
    queryFn: () => {
      if (!siteId) throw new Error('The exceptions need a site');
      return webScanApi.getExceptions(siteId);
    },
    enabled: siteId !== undefined,
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}

export function useWebScanCreateExceptionMutation() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (input: { siteId: string; body: WebScanCreateExceptionRequest }) =>
      webScanApi.createException(input.siteId, input.body),
    onSuccess: () => {
      showToast(t('webscanExceptionCreated'), 'success');
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'exceptions'] });
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'scan'] });
    },
  });
}

export function useWebScanDeleteExceptionMutation() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (input: { siteId: string; exceptionId: string }) =>
      webScanApi.deleteException(input.siteId, input.exceptionId),
    onSuccess: () => {
      showToast(t('webscanExceptionRevoked'), 'success');
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'exceptions'] });
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'scan'] });
    },
  });
}

/** The immutable audit log of the area. */
export function useWebScanAuditQuery(offset: number) {
  return useQuery({
    queryKey: ['webscan', 'audit', offset],
    queryFn: () => webScanApi.getAudit({ limit: WEB_SCAN_AUDIT_PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
    ...WEB_SCAN_QUERY_OPTIONS,
  });
}
