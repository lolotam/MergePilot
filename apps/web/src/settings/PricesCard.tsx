import { useState, type ReactNode } from 'react';
import { Pencil, RotateCcw, Tags } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError, fetchApi, type PricesResponse } from '../api/client.js';
import { formatDateTime } from '../admin/format.js';
import { useI18n } from '../i18n/context.js';
import { PriceEditRow, type PriceFields } from './PriceEditRow.js';
import {
  formatPerMTok,
  formatRelative,
  priceSourceKey,
  removeOverride,
  roleLabels,
  upsertOverride,
  type PricedModel,
} from './price-format.js';
import { usePatchSettings, useWorkspaceSettings } from './useSettingsPatch.js';

const badgeClass = 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap';
const thClass = 'py-2.5 px-3 text-start font-semibold';
const dash = <span className="text-ink-400 dark:text-ink-500">—</span>;

/** One table row: the same model may appear twice (e.g. main and heavy), so rows are told apart by role and position. */
const rowKey = (m: PricedModel, index: number) => `${m.role}:${index}`;

function SourceBadge({ source }: { source: string }) {
  const { t } = useI18n();
  const key = priceSourceKey(source);
  const label = key ? t(key) : source;
  const color =
    source === 'unknown'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
      : source === 'override'
        ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-300'
        : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300';
  return <span className={`${badgeClass} ${color}`}>{label}</span>;
}

interface PricesCardProps {
  workspaceId: string;
  isMember: boolean;
}

/** «أسعار النماذج» — the price of every model the workspace uses and its manual prices (ADR-0016). */
export function PricesCard({ workspaceId, isMember }: PricesCardProps) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const settingsQuery = useWorkspaceSettings(workspaceId);
  const settings = settingsQuery.data?.settings;
  // The model list follows the configured models: a new main, heavy, fallback or Jev model
  // gets its own cache entry, so the card refetches right after the settings change.
  const modelsKey = settings
    ? JSON.stringify([settings.provider, settings.model, settings.heavyProvider, settings.heavyModel, settings.fallback, settings.judge])
    : null;
  const pricesKey = ['workspaces', workspaceId, 'prices', modelsKey];
  const pricesQuery = useQuery({
    queryKey: pricesKey,
    queryFn: () => fetchApi<PricesResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/prices`),
    enabled: Boolean(workspaceId && settings),
  });
  const [editing, setEditing] = useState<string | null>(null);
  // A refetch must not advance the version of an editor that still holds its earlier local draft.
  const [editingVersion, setEditingVersion] = useState<string | undefined>();
  const patch = usePatchSettings(workspaceId, 'pricesSaved', editing === null ? undefined : editingVersion);
  const [serverError, setServerError] = useState<string | null>(null);

  const models = pricesQuery.data?.models ?? [];
  const roles = roleLabels(models, t);
  const disabled = isMember || !settings || patch.isPending;
  const colSpan = isMember ? 6 : 7;

  const saveOverrides = (next: NonNullable<NonNullable<typeof settings>['priceOverrides']>, onDone?: () => void) => {
    setServerError(null);
    patch.mutate(
      { priceOverrides: next },
      {
        onSuccess: () => onDone?.(),
        onError: (err: Error) => {
          setServerError(err.message || t('error'));
          if (err instanceof ApiClientError && err.code === 'settings_conflict') setEditing(null);
        },
        onSettled: () => void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'prices'] }),
      },
    );
  };
  const current = settings?.priceOverrides ?? [];
  const saveManual = (m: PricedModel, fields: PriceFields) =>
    saveOverrides(upsertOverride(current, { provider: m.provider, model: m.model, ...fields }), () => setEditing(null));
  const restoreAutomatic = (m: PricedModel) => saveOverrides(removeOverride(current, m.provider, m.model), () => setEditing(null));

  const priceCell = (value: number | undefined, title?: string) =>
    value === undefined ? (
      dash
    ) : (
      <span dir="ltr" className="font-mono tabular-nums" title={title}>
        {formatPerMTok(value)}
      </span>
    );

  let body: ReactNode;
  if (settingsQuery.isError) body = <p className="text-xs text-amber-700 dark:text-amber-300">{t('pricesLoadError')}</p>;
  else if (settings === null) body = <p className="text-xs text-ink-500 dark:text-ink-400">{t('pricesNone')}</p>;
  else if (!settings || pricesQuery.isLoading) body = <div className="text-sm text-ink-400">{t('loading')}</div>;
  else if (pricesQuery.isError) body = <p className="text-xs text-amber-700 dark:text-amber-300">{t('pricesLoadError')}</p>;
  else
    body = (
      <div className="overflow-x-auto">
        <table className="w-full text-start text-xs">
          <thead>
            <tr className="border-b border-ink-200 dark:border-ink-800 text-[11px] text-ink-500 dark:text-ink-400">
              <th className={thClass}>{t('pricesRoleCol')}</th>
              <th className={thClass}>{t('pricesModelCol')}</th>
              <th className={thClass}>{t('pricesInputCol')}</th>
              <th className={thClass}>{t('pricesOutputCol')}</th>
              <th className={thClass}>{t('pricesSourceCol')}</th>
              <th className={thClass}>{t('pricesFetchedCol')}</th>
              {!isMember && <th className={`${thClass} text-end`}>{t('actions')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800/50">
            {models.map((m, index) => {
              const cacheRead = m.price?.cacheReadPerMTok;
              const cacheTitle = cacheRead === undefined ? undefined : t('pricesCacheRead', { price: formatPerMTok(cacheRead) });
              return [
                <tr key={`${m.role}-${index}`} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40">
                  <td className="py-2.5 px-3">
                    <span className={`${badgeClass} bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300`}>{roles[index]}</span>
                  </td>
                  <td className="py-2.5 px-3 max-w-[14rem]" dir="ltr">
                    <div className="flex flex-col min-w-0 font-mono">
                      <span className="text-[10px] text-ink-500 dark:text-ink-400 truncate">{m.provider}</span>
                      <span className="text-[11px] text-ink-900 dark:text-ink-100 truncate" title={m.model}>
                        {m.model}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3">{priceCell(m.price?.inputPerMTok, cacheTitle)}</td>
                  <td className="py-2.5 px-3">{priceCell(m.price?.outputPerMTok)}</td>
                  <td className="py-2.5 px-3">
                    <SourceBadge source={m.source} />
                  </td>
                  <td className="py-2.5 px-3 text-ink-500 dark:text-ink-400 whitespace-nowrap">
                    {m.fetchedAt ? (
                      <span data-testid="price-fetched-at" title={formatDateTime(m.fetchedAt, language)}>
                        {formatRelative(m.fetchedAt, language)}
                      </span>
                    ) : (
                      dash
                    )}
                  </td>
                  {!isMember && (
                    <td className="py-2.5 px-3 text-end">
                      <div className="inline-flex items-center gap-1.5 justify-end">
                        {m.overridden ? (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => restoreAutomatic(m)}
                            title={t('pricesUseAutomatic')}
                            aria-label={t('pricesUseAutomatic')}
                            className="p-1.5 rounded-full text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-40"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setServerError(null);
                            setEditingVersion(settingsQuery.data?.settingsVersion);
                            setEditing(rowKey(m, index));
                          }}
                          title={t('pricesEdit')}
                          aria-label={t('pricesEdit')}
                          className="p-1.5 rounded-full text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/40 disabled:opacity-40"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>,
                !isMember && editing === rowKey(m, index) ? (
                  <PriceEditRow
                    key={`${m.role}-${index}-edit`}
                    model={m}
                    colSpan={colSpan}
                    saving={patch.isPending}
                    serverError={serverError}
                    onSave={(fields) => saveManual(m, fields)}
                    onCancel={() => setEditing(null)}
                  />
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    );

  const sources = pricesQuery.data?.sources ?? [];
  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Tags className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('pricesCardTitle')}</h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{t('pricesCardDesc')}</p>
        </div>
      </div>
      {body}
      {sources.length > 0 ? (
        <p data-testid="price-sources" className="mt-3 text-[11px] text-ink-500 dark:text-ink-400">
          <span>{t('pricesLastRefresh')}: </span>
          {sources.map((s, i) => {
            const key = priceSourceKey(`catalog:${s.source}`);
            return (
              <span key={s.source} title={s.fetchedAt ? formatDateTime(s.fetchedAt, language) : undefined}>
                {i > 0 ? ' · ' : ''}
                {key ? t(key) : s.source}: {s.fetchedAt ? formatRelative(s.fetchedAt, language) : t('pricesNever')}
              </span>
            );
          })}
        </p>
      ) : null}
      <p className="mt-3 text-[11px] text-ink-500 dark:text-ink-400 leading-relaxed">{t('pricesNote')}</p>
    </div>
  );
}
