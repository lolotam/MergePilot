import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AdminWorkspace } from '../api/admin.js';
import { useI18n } from '../i18n/context.js';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.js';
import { formatCount, formatDateTime, formatUsd } from './format.js';
import { ADMIN_PAGE_SIZE, useAdminDeleteWorkspaceMutation, useAdminWorkspacesQuery } from './hooks.js';
import { Badge, Pager, StateMessage, TableCard, tbodyClass, tdClass, thClass, theadClass } from './ui.js';

export function WorkspacesTab() {
  const { t, language } = useI18n();
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<AdminWorkspace | null>(null);
  const { data, isLoading, isError } = useAdminWorkspacesQuery({ limit: ADMIN_PAGE_SIZE, offset });
  const remove = useAdminDeleteWorkspaceMutation();
  const workspaces = data?.workspaces ?? [];

  let body;
  if (isLoading) body = <StateMessage>{t('loading')}</StateMessage>;
  else if (isError) body = <StateMessage>{t('adminLoadError')}</StateMessage>;
  else if (workspaces.length === 0) body = <StateMessage>{t('noWorkspacesFound')}</StateMessage>;
  else {
    body = (
      <table className="w-full text-start text-xs">
        <thead className={theadClass}>
          <tr>
            <th className={thClass}>{t('colWorkspace')}</th>
            <th className={thClass}>{t('colOwner')}</th>
            <th className={thClass}>{t('colMembers')}</th>
            <th className={thClass}>{t('colInstallations')}</th>
            <th className={thClass}>{t('colConfiguredProviders')}</th>
            <th className={thClass}>{t('colRunsCost')}</th>
            <th className={thClass}>{t('colLastRun')}</th>
            <th className={thClass}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {workspaces.map((ws) => (
            <tr key={ws.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 transition-colors">
              <td className={tdClass}>
                <div className="min-w-[160px]">
                  <p className="font-semibold text-ink-900 dark:text-ink-100">{ws.name}</p>
                  <p className="text-[11px] text-ink-500 dark:text-ink-400 font-mono" dir="ltr">
                    {ws.slug}
                  </p>
                  <p className="text-[10px] text-ink-400">{formatDateTime(ws.createdAt, language)}</p>
                </div>
              </td>
              <td className={`${tdClass} text-xs`} dir="ltr">
                {ws.ownerEmail ?? '—'}
              </td>
              <td className={`${tdClass} tabular-nums font-semibold`}>{formatCount(ws.memberCount, language)}</td>
              <td className={tdClass}>
                <ul className="flex flex-col gap-1 min-w-[150px]">
                  {ws.installations.length === 0 && <li className="text-ink-400">—</li>}
                  {ws.installations.map((inst) => (
                    <li key={inst.id} className="flex flex-wrap items-center gap-1 text-xs">
                      <span className="font-medium" dir="ltr">
                        {inst.accountLogin}
                      </span>
                      <Badge>
                        {inst.repositorySelection === 'all' ? t('repoScopeAll') : t('repoScopeSelected')}
                      </Badge>
                      {inst.suspended && <Badge tone="danger">{t('adminSuspended')}</Badge>}
                    </li>
                  ))}
                </ul>
              </td>
              <td className={tdClass}>
                <div className="flex flex-wrap gap-1">
                  {ws.providers.length === 0 && <span className="text-ink-400">—</span>}
                  {ws.providers.map((p) => (
                    <Badge key={p} tone="brand">
                      {p}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className={`${tdClass} whitespace-nowrap tabular-nums`}>
                <span className="font-semibold">{formatCount(ws.runsCount, language)}</span>
                <span className="text-ink-400"> · </span>
                <span>{formatUsd(ws.costUsdTotal, language)}</span>
              </td>
              <td className={`${tdClass} text-xs whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                {formatDateTime(ws.lastRunAt, language)}
              </td>
              <td className={`${tdClass} text-end`}>
                <button
                  type="button"
                  onClick={() => setPending(ws)}
                  aria-label={`${t('deleteWorkspace')}: ${ws.name}`}
                  title={t('deleteWorkspace')}
                  className="p-1.5 rounded-full text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <>
      <TableCard footer={<Pager page={data} onChange={setOffset} />}>{body}</TableCard>
      <ConfirmDeleteDialog
        isOpen={pending !== null}
        title={t('deleteWorkspaceConfirmTitle')}
        description={t('deleteWorkspaceConfirmDesc')}
        confirmLabel={t('deleteWorkspace')}
        requiredText={pending?.name ?? ''}
        isPending={remove.isPending}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          remove.mutate(pending.id, { onSettled: () => setPending(null) });
        }}
      />
    </>
  );
}
