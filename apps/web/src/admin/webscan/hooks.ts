import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WebScanCreateExceptionRequest,
  WebScanCreateSiteRequest,
  WebScanEnqueueManualRequest,
  WebScanLimitField,
  WebScanSettingsPatchRequest,
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
/** How many sites the picker of the scan panels offers at once. */
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
    // A lost admin right is answered with a 404, and a retry would only repeat it.
    retry: false,
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
    retry: false,
  });
}

/** The sites the picker of the scan panels offers. */
export function useWebScanSiteOptionsQuery() {
  return useQuery({
    queryKey: ['webscan', 'sites', 'options'],
    queryFn: () => webScanApi.getSites({ limit: WEB_SCAN_SITE_OPTIONS_LIMIT, offset: 0 }),
    retry: false,
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
    placeholderData: keepPreviousData,
    retry: false,
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
    retry: false,
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
    retry: false,
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
    retry: false,
  });
}
