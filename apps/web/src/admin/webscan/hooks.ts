import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WebScanCreateSiteRequest,
  WebScanSettingsPatchRequest,
  WebScanUpdateSiteRequest,
} from '@mergepilot/app/contract';
import { ApiClientError } from '../../api/client.js';
import { webScanApi } from '../../api/webscan.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';

/** The page size of the sites list. */
export const WEB_SCAN_SITES_PAGE_SIZE = 25;

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
 * The digest the server sent with the refusal, when it sent one. The API
 * follow-up adds it to the error body; until then the dashboard builds the
 * digest itself from the same effective values.
 */
export function serverConfirmationDigest(error: unknown): string | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  const digest = error.details['digest'];
  return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
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

