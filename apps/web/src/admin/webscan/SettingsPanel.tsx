import { useEffect, useState } from 'react';
import type { WebScanLimits, WebScanSettingsPatchRequest } from '@mergepilot/app/contract';
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
  isPermissionLost,
  needsAboveDefaultConfirmation,
  serverConfirmationDigest,
  useWebScanSettingsQuery,
  useWebScanUpdateSettingsMutation,
} from './hooks.js';
import { effectiveLimits, limitsAboveDefault, limitsConfirmationDigest } from './limits.js';
import {
  buildSettingsPatch,
  toSettingsDraft,
  type SettingsDraft,
} from './settings-draft.js';
import { ErrorState, LoadingState, PermissionLostState } from './states.js';

/** A change that waits for the second confirmation of a value above its default. */
interface PendingConfirmation {
  patch: WebScanSettingsPatchRequest;
  effective: WebScanLimits;
  /** The digest the server sent with the refusal, when it sent one. */
  digest?: string | undefined;
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
  const update = useWebScanUpdateSettingsMutation();
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    if (data) setDraft(toSettingsDraft(data));
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (isError) return isPermissionLost(error) ? <PermissionLostState /> : <ErrorState />;
  if (!data || !draft) return <LoadingState />;

  const togglePaused = (paused: boolean) => {
    setDraft({ ...draft, paused });
    setMessage(null);
    update.mutate(
      { paused },
      {
        onError: (err: Error) => {
          setDraft(toSettingsDraft(data));
          setMessage(err.message);
        },
      },
    );
  };

  const save = () => {
    const patch = buildSettingsPatch(data, draft);
    if (Object.keys(patch).length === 0) {
      setMessage(t('webscanNothingToSave'));
      return;
    }
    setMessage(null);
    update.mutate(patch, {
      onSuccess: () => showToast(t('webscanSettingsSaved'), 'success'),
      onError: (err: Error) => {
        if (!needsAboveDefaultConfirmation(err)) {
          setMessage(err.message);
          return;
        }
        const effective = effectiveLimits(data.limits, patch.limits);
        setPending({ patch, effective, digest: serverConfirmationDigest(err) });
      },
    });
  };

  const confirmAboveDefault = async () => {
    if (!pending) return;
    const digest = pending.digest ?? (await limitsConfirmationDigest(pending.effective));
    update.mutate(
      { ...pending.patch, limitConfirmation: { digest } },
      {
        onSuccess: () => {
          setPending(null);
          showToast(t('webscanSettingsSaved'), 'success');
        },
        onError: (err: Error) => {
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
      <ApprovedInstallationsCard installations={data.approvedInstallations} />

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
        fields={pending ? limitsAboveDefault(pending.effective) : []}
        limits={pending?.effective ?? data.limits}
        isPending={update.isPending}
        onConfirm={() => void confirmAboveDefault()}
        onClose={() => setPending(null)}
      />
    </div>
  );
}
