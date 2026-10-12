import { useId, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { formatDateTime, formatUsd } from './format.js';
import { useAdminRunsQuery, useAdminWorkspacesQuery } from './hooks.js';
import { Pager, StateMessage, StatusBadge, TableCard, tbodyClass, tdClass, thClass, theadClass } from './ui.js';

export function RunsTab() {
  const { t, language } = useI18n();
  const selectId = useId();
  const [offset, setOffset] = useState(0);
  const [workspaceId, setWorkspaceId] = useState('');
  const { data, isLoading, isError } = useAdminRunsQuery(offset, workspaceId);
  const { data: wsData } = useAdminWorkspacesQuery({ limit: 100, offset: 0 });
  const runs = data?.runs ?? [];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={selectId} className="text-sm font-medium text-gray-600 dark:text-gray-300">
        {t('filterWorkspace')}
      </label>
      <select
        id={selectId}
        value={workspaceId}
        onChange={(e) => {
          setWorkspaceId(e.target.value);
          setOffset(0);
        }}
        className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-950 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
      >
        <option value="">{t('allWorkspaces')}</option>
        {(wsData?.workspaces ?? []).map((ws) => (
          <option key={ws.id} value={ws.id}>
            {ws.name}
          </option>
        ))}
      </select>
    </div>
  );

  let body;
  if (isLoading) body = <StateMessage>{t('loading')}</StateMessage>;
  else if (isError) body = <StateMessage>{t('adminLoadError')}</StateMessage>;
  else if (runs.length === 0) body = <StateMessage>{t('noRunsFound')}</StateMessage>;
  else {
    body = (
      <table className="w-full text-start text-sm">
        <thead className={theadClass}>
          <tr>
            <th className={thClass}>{t('colWorkspace')}</th>
            <th className={thClass}>{t('colRepo')}</th>
            <th className={thClass}>{t('colPR')}</th>
            <th className={thClass}>{t('runStatusCol')}</th>
            <th className={thClass}>{t('colCost')}</th>
            <th className={thClass}>{t('colCreated')}</th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-gray-50/50 dark:hover:bg-ink-800/40">
              <td className={`${tdClass} whitespace-nowrap`}>
                {run.workspaceName ?? (
                  <span className="text-gray-400">{t('adminDeletedWorkspace')}</span>
                )}
              </td>
              <td className={`${tdClass} font-medium whitespace-nowrap`} dir="ltr">
                {run.repoFullName}
              </td>
              <td className={tdClass}>
                <a
                  href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t('viewPrOnGitHub')}
                  className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline font-mono text-xs font-semibold"
                >
                  #{run.pullNumber}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </td>
              <td className={tdClass}>
                <StatusBadge status={run.status} />
              </td>
              <td className={`${tdClass} font-mono text-xs whitespace-nowrap`}>
                {formatUsd(run.costUsd, language)}
              </td>
              <td className={`${tdClass} text-xs whitespace-nowrap text-gray-500 dark:text-gray-400`}>
                {formatDateTime(run.createdAt, language)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <TableCard toolbar={toolbar} footer={<Pager page={data} onChange={setOffset} />}>
      {body}
    </TableCard>
  );
}
