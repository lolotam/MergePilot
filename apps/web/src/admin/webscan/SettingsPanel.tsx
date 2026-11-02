import { useEffect, useRef, useState } from 'react';
import type {
  WebScanLimitField,
  WebScanLimits,
  WebScanSettingsDto,
  WebScanSettingsPatchRequest,
} from '@mergepilot/app/contract';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { Badge } from '../ui.js';
import { AlertsCard } from './AlertsCard.js';
import { ApprovedInstallationsCard } from './ApprovedInstallationsCard.js';
import { AboveDefaultDialog } from './AboveDefaultDialog.js';
import { ChecksCard } from './ChecksCard.js';
import { LimitsCard } from './LimitsCard.js';
import { ScheduleCard } from './ScheduleCard.js';
import { SettingsCard, Toggle } from './components.js';
import {
  aboveDefaultConfirmation,
  isPermissionLost,
  needsAboveDefaultConfirmation,
  useWebScanSettingsQuery,
  useWebScanUpdateSettingsMutation,
} from './hooks.js';
import { useWebScanRights } from './rights.js';
import {
  buildSettingsPatch,
  isOlderSettings,
  rebaseDraft,
  toSettingsDraft,
  type SettingsDraft,
} from './settings-draft.js';
import { ErrorState, LoadingState, PermissionLostState } from './states.js';

/** A change that waits for the second confirmation of a value above its default. */
interface PendingConfirmation {
  patch: WebScanSettingsPatchRequest;
  /** The effective limits the server bound its digest to. */
  effective: WebScanLimits;
  /** The digest the server sent with its refusal. */
  digest: string;
  /** The limit fields the server named as above their default. */
  fields: WebScanLimitField[];
}

/**
 * The global policy of the website security scan (ADR-0052 section 5).
 *
 * The panel shows the effective values, the kill switch and the read-only
 * approved bindings. Every change goes through one PATCH that carries only the
 * fields the administrator changed.
 */
export function SettingsPanel() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { data, isLoading, isError, error } = useWebScanSettingsQuery();
  const rights = useWebScanRights();
  const update = useWebScanUpdateSettingsMutation();
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  // The answer of the server the draft was built from: every patch is the difference
  // to it, so a field the administrator did not touch is never sent.
  const [baseline, setBaseline] = useState<WebScanSettingsDto | null>(null);
  // The newest baseline, for the callbacks that answer long after the click
  // that started them: a refetch may have installed a newer answer of the
  // server in between.
  const baselineRef = useRef<WebScanSettingsDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    // The draft is the work of the administrator. A newer answer of the server never
    // overwrites an edit that is not saved yet, and it is never ignored either: the
    // fields the administrator did not touch follow it (the kill switch included).
    if (!data) return;
    if (baseline === null || draft === null) {
      baselineRef.current = data;
      setBaseline(data);
      setDraft(toSettingsDraft(data));
      return;
    }
    if (data === baseline) return;
    // An answer that is older than the baseline was already on its way when the
    // baseline was installed: it never moves the draft nor the baseline back.
    if (isOlderSettings(data, baseline)) return;
    const rebased = rebaseDraft(baseline, draft, data);
    baselineRef.current = data;
    setDraft(rebased);
    setBaseline(data);
  }, [data, baseline, draft]);

  if (rights.lost) return <PermissionLostState />;
  if (isLoading) return <LoadingState />;
  if (isError) return isPermissionLost(error) ? <PermissionLostState /> : <ErrorState />;
  if (!draft || !baseline) return <LoadingState />;

  const togglePaused = (paused: boolean) => {
    setDraft({ ...draft, paused });
    setMessage(null);
    update.mutate(
      { paused },
      {
        onError: (err: Error) => {
          if (rights.report(err)) return;
          // Only the pause goes back to the state of the server: the other
          // edits of the administrator stay in the form. The state is the one of
          // the newest answer of the server and not the one of the click: a
          // refetch that landed while the request was on its way is newer.
          const server = baselineRef.current;
          setDraft((current) =>
            current === null || server === null ? current : { ...current, paused: server.paused },
          );
          setMessage(err.message);
        },
      },
    );
  };

  const save = () => {
    const patch = buildSettingsPatch(baseline, draft);
    if (Object.keys(patch).length === 0) {
      setMessage(t('webscanNothingToSave'));
      return;
    }
    setMessage(null);
    update.mutate(patch, {
      onSuccess: () => showToast(t('webscanSettingsSaved'), 'success'),
      onError: (err: Error) => {
        if (rights.report(err)) return;
        if (!needsAboveDefaultConfirmation(err)) {
          setMessage(err.message);
          return;
        }
        // The server is the only authority of the confirmation: it sends the
        // digest of the values it is about to store and the names of the
        // fields that are above their default.
        const confirmation = aboveDefaultConfirmation(err);
        if (!confirmation) {
          // The refusal carries no confirmation the panel can build: the
          // values the server would store are unknown, so the panel says so
          // and keeps the draft of the administrator on the screen.
          setMessage(t('webscanSettingsSaveFailed', { message: err.message }));
          return;
        }
        // The values of the dialog are the ones of the server: they are the
        // effective limits its digest was computed from, so the administrator
        // confirms exactly what the server is about to store.
        setPending({
          patch,
          effective: confirmation.effectiveLimits,
          digest: confirmation.digest,
          fields: confirmation.fields,
        });
      },
    });
  };

  const confirmAboveDefault = () => {
    if (!pending) return;
    update.mutate(
      { ...pending.patch, limitConfirmation: { digest: pending.digest } },
      {
        onSuccess: () => {
          setPending(null);
          showToast(t('webscanSettingsSaved'), 'success');
        },
        onError: (err: Error) => {
          if (rights.report(err)) return;
          setPending(null);
          setMessage(err.message);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-serif text-lg font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('webscanSettingsTitle')}
        </h2>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{t('webscanSettingsDesc')}</p>
      </header>

      <SettingsCard title={t('webscanPauseTitle')} hint={t('webscanPauseDesc')}>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            checked={draft.paused}
            label={t('webscanPauseTitle')}
            disabled={update.isPending}
            onChange={togglePaused}
          />
          <Badge tone={draft.paused ? 'warning' : 'success'}>
            {draft.paused ? t('webscanPausedBadge') : t('webscanRunningBadge')}
          </Badge>
          <span className="text-[11px] text-ink-500 dark:text-ink-400">
            {draft.paused ? t('webscanResumeAction') : t('webscanPauseAction')}
          </span>
        </div>
      </SettingsCard>

      <LimitsCard
        limits={draft.limits}
        onChange={(limits) => setDraft({ ...draft, limits })}
      />
      <ChecksCard checks={draft.checks} onChange={(checks) => setDraft({ ...draft, checks })} />
      <ScheduleCard
        schedule={draft.defaultSchedule}
        onChange={(defaultSchedule) => setDraft({ ...draft, defaultSchedule })}
      />
      <AlertsCard draft={draft} onChange={setDraft} />
      {/* Every value the server owns is read from the baseline, never from the
          last answer of the query: an answer that was already on its way when
          the baseline was installed is older than it and must not replace it. */}
      <ApprovedInstallationsCard installations={baseline.approvedInstallations} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={update.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
        >
          {update.isPending ? t('saving') : t('save')}
        </button>
        {message && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400 break-words">
            {message}
          </p>
        )}
      </div>

      <AboveDefaultDialog
        isOpen={pending !== null}
        fields={pending?.fields ?? []}
        limits={pending?.effective ?? baseline.limits}
        isPending={update.isPending}
        onConfirm={confirmAboveDefault}
        onClose={() => setPending(null)}
      />
    </div>
  );
}
