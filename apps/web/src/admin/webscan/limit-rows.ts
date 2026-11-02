import type { WebScanLimits } from '@mergepilot/app/contract';

/**
 * The limit rows of the dashboard: the field, the label and the unit.
 *
 * The order is the order of the limits of the ADR, so the card and the dialog
 * always walk the fields in the same order.
 */
export const WEB_SCAN_LIMIT_ROWS = [
  { field: 'maxRequests', label: 'webscanLimitMaxRequests', unit: 'webscanUnitRequests' },
  { field: 'maxPages', label: 'webscanLimitMaxPages', unit: 'webscanUnitPages' },
  { field: 'maxActiveLinks', label: 'webscanLimitMaxActiveLinks', unit: 'webscanUnitLinks' },
  {
    field: 'requestsPerSecond',
    label: 'webscanLimitRequestsPerSecond',
    unit: 'webscanUnitPerSecond',
  },
  {
    field: 'requestTimeoutMs',
    label: 'webscanLimitRequestTimeoutMs',
    unit: 'webscanUnitMilliseconds',
  },
  {
    field: 'maxResponseBytes',
    label: 'webscanLimitMaxResponseBytes',
    unit: 'webscanUnitBytes',
  },
  {
    field: 'totalTimeoutMs',
    label: 'webscanLimitTotalTimeoutMs',
    unit: 'webscanUnitMilliseconds',
  },
] as const satisfies readonly { field: keyof WebScanLimits; label: string; unit: string }[];
