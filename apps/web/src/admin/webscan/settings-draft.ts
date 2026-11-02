import type {
  WebScanChecks,
  WebScanLimits,
  WebScanLimitsPatch,
  WebScanSchedule,
  WebScanSettingsDto,
  WebScanSettingsPatchRequest,
} from '@mergepilot/app/contract';

/**
 * The editable shape of the global policy (ADR-0052 section 5).
 *
 * The dashboard never edits the stored row directly: it keeps a draft, and it
 * sends only the fields that changed, so two administrators editing different
 * settings do not overwrite each other.
 */
export interface SettingsDraft {
  paused: boolean;
  alertsEnabled: boolean;
  limits: WebScanLimits;
  checks: WebScanChecks;
  defaultSchedule: WebScanSchedule;
  retentionDays: number;
  contact: string;
  alertMinSeverity: WebScanSettingsDto['alertMinSeverity'];
  alertMinValidation: WebScanSettingsDto['alertMinValidation'];
}

/** The frequency of a schedule, as the contract names it. */
export type ScheduleFrequency = WebScanSchedule['frequency'];

/** The schedule as the form holds it: every field, the irrelevant ones included. */
export interface ScheduleDraft {
  frequency: ScheduleFrequency;
  weekday: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  enabled: boolean;
}

export function toSettingsDraft(settings: WebScanSettingsDto): SettingsDraft {
  return {
    paused: settings.paused,
    alertsEnabled: settings.alertsEnabled,
    limits: { ...settings.limits },
    checks: { ...settings.checks },
    defaultSchedule: { ...settings.defaultSchedule },
    retentionDays: settings.retentionDays,
    contact: settings.contact,
    alertMinSeverity: settings.alertMinSeverity,
    alertMinValidation: settings.alertMinValidation,
  };
}

export function toScheduleDraft(schedule: WebScanSchedule): ScheduleDraft {
  return {
    frequency: schedule.frequency,
    weekday: schedule.weekday ?? 0,
    dayOfMonth: schedule.dayOfMonth ?? 1,
    hour: schedule.hour,
    minute: schedule.minute,
    enabled: schedule.enabled,
  };
}

/**
 * The schedule as the API takes it: the frequency decides which day field is
 * required, and the irrelevant ones are left out.
 */
export function toSchedule(draft: ScheduleDraft): WebScanSchedule {
  const base = {
    frequency: draft.frequency,
    hour: draft.hour,
    minute: draft.minute,
    enabled: draft.enabled,
  };
  if (draft.frequency === 'weekly' || draft.frequency === 'biweekly') {
    return { ...base, weekday: draft.weekday };
  }
  if (draft.frequency === 'monthly') {
    return { ...base, dayOfMonth: draft.dayOfMonth };
  }
  return base;
}

function changedLimits(base: WebScanLimits, draft: WebScanLimits): WebScanLimitsPatch | undefined {
  const patch: WebScanLimitsPatch = {};
  if (draft.maxRequests !== base.maxRequests) patch.maxRequests = draft.maxRequests;
  if (draft.maxPages !== base.maxPages) patch.maxPages = draft.maxPages;
  if (draft.maxActiveLinks !== base.maxActiveLinks) patch.maxActiveLinks = draft.maxActiveLinks;
  if (draft.requestsPerSecond !== base.requestsPerSecond) {
    patch.requestsPerSecond = draft.requestsPerSecond;
  }
  if (draft.requestTimeoutMs !== base.requestTimeoutMs) patch.requestTimeoutMs = draft.requestTimeoutMs;
  if (draft.maxResponseBytes !== base.maxResponseBytes) patch.maxResponseBytes = draft.maxResponseBytes;
  if (draft.totalTimeoutMs !== base.totalTimeoutMs) patch.totalTimeoutMs = draft.totalTimeoutMs;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function changedChecks(base: WebScanChecks, draft: WebScanChecks): WebScanChecks | undefined {
  const same =
    base.headers === draft.headers &&
    base.cookies === draft.cookies &&
    base.transport === draft.transport &&
    base.disclosure === draft.disclosure &&
    base.files === draft.files &&
    base.active === draft.active;
  return same ? undefined : { ...draft };
}

/** Whether two schedules mean the same rule. */
export function sameSchedule(a: WebScanSchedule, b: WebScanSchedule): boolean {
  return (
    a.frequency === b.frequency &&
    (a.weekday ?? null) === (b.weekday ?? null) &&
    (a.dayOfMonth ?? null) === (b.dayOfMonth ?? null) &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.enabled === b.enabled
  );
}

/** The patch of the fields the administrator changed, and nothing else. */
export function buildSettingsPatch(
  base: WebScanSettingsDto,
  draft: SettingsDraft,
): WebScanSettingsPatchRequest {
  const patch: WebScanSettingsPatchRequest = {};
  if (draft.paused !== base.paused) patch.paused = draft.paused;
  if (draft.alertsEnabled !== base.alertsEnabled) patch.alertsEnabled = draft.alertsEnabled;

  const limits = changedLimits(base.limits, draft.limits);
  if (limits !== undefined) patch.limits = limits;

  const checks = changedChecks(base.checks, draft.checks);
  if (checks !== undefined) patch.checks = checks;

  if (!sameSchedule(base.defaultSchedule, draft.defaultSchedule)) {
    patch.defaultSchedule = draft.defaultSchedule;
  }

  if (draft.retentionDays !== base.retentionDays) patch.retentionDays = draft.retentionDays;
  if (draft.contact !== base.contact) patch.contact = draft.contact;
  if (draft.alertMinSeverity !== base.alertMinSeverity) patch.alertMinSeverity = draft.alertMinSeverity;
  if (draft.alertMinValidation !== base.alertMinValidation) {
    patch.alertMinValidation = draft.alertMinValidation;
  }
  return patch;
}

/** True when the administrator did not touch a value since the baseline it came from. */
function untouched<T>(baseline: T, draft: T): boolean {
  return JSON.stringify(baseline) === JSON.stringify(draft);
}

/** Merges one record field by field: an edited field stays, an untouched one follows the server. */
function mergeRecord<T extends object>(baseline: T, draft: T, server: T): T {
  const merged: T = { ...server };
  for (const key of Object.keys(server) as Array<keyof T>) {
    merged[key] = untouched(baseline[key], draft[key]) ? server[key] : draft[key];
  }
  return merged;
}

/**
 * Moves a draft onto a newer answer of the server.
 *
 * What the administrator edited stays as it is; everything else follows the
 * server, so a change another administrator (or another tab) made, the kill
 * switch above all, is never silently reverted by an unrelated save.
 */
export function rebaseDraft(
  baseline: WebScanSettingsDto,
  draft: SettingsDraft,
  server: WebScanSettingsDto,
): SettingsDraft {
  const before = toSettingsDraft(baseline);
  const after = toSettingsDraft(server);
  const pick = <K extends 'paused' | 'alertsEnabled' | 'retentionDays' | 'contact' | 'alertMinSeverity' | 'alertMinValidation' | 'defaultSchedule'>(
    key: K,
  ): SettingsDraft[K] => (untouched(before[key], draft[key]) ? after[key] : draft[key]);
  return {
    paused: pick('paused'),
    alertsEnabled: pick('alertsEnabled'),
    limits: mergeRecord(before.limits, draft.limits, after.limits),
    checks: mergeRecord(before.checks, draft.checks, after.checks),
    defaultSchedule: pick('defaultSchedule'),
    retentionDays: pick('retentionDays'),
    contact: pick('contact'),
    alertMinSeverity: pick('alertMinSeverity'),
    alertMinValidation: pick('alertMinValidation'),
  };
}
