import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { formatDateTime, formatUsd } from './format.js';
import { useAdminRunsQuery, useDebouncedValue } from './hooks.js';
import {
  Pager,
  SearchInput,
  StateMessage,
  StatusBadge,
  TableCard,
  tbodyClass,
  tdClass,
  thClass,
  theadClass,
} from './ui.js';

export function RunsTab() {
  const { t, language } = useI18n();
  const [offset, setOffset] = useState(0);
  const [workspaceSearch, setWorkspaceSearch] = useState('');
  const workspaceQuery = useDebouncedValue(workspaceSearch.trim());
  const { data, isLoading, isError } = useAdminRunsQuery(offset, workspaceQuery);
  const runs = data?.runs ?? [];

  const toolbar = (
    <SearchInput
      value={workspaceSearch}
      onChange={(value) => {
        setWorkspaceSearch(value);
        setOffset(0);
      }}
      placeholder={t('filterWorkspace')}
    />
  );

  let body;
  if (isLoading) body = <StateMessage>{t('loading')}</StateMessage>;
  else if (isError) body = <StateMessage>{t('adminLoadError')}</StateMessage>;
  else if (runs.length === 0) body = <StateMessage>{t('noRunsFound')}</StateMessage>;
  else {
    body = (
      <table className="w-full text-start text-xs">
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
            <tr key={run.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 transition-colors">
              <td className={`${tdClass} whitespace-nowrap font-medium text-ink-900 dark:text-ink-100`}>
                {run.workspaceName ?? (
                  <span className="text-ink-400">{t('adminDeletedWorkspace')}</span>
                )}
              </td>
              <td className={`${tdClass} font-semibold whitespace-nowrap text-ink-900 dark:text-ink-100`} dir="ltr">
                {run.repoFullName}
              </td>
              <td className={tdClass}>
                <a
                  href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t('viewPrOnGitHub')}
                  className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-300 hover:underline font-mono text-xs font-semibold"
                >
                  #{run.pullNumber}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </td>
              <td className={tdClass}>
                <StatusBadge status={run.status} />
              </td>
              <td className={`${tdClass} font-mono text-xs whitespace-nowrap text-ink-900 dark:text-ink-100`}>
                {formatUsd(run.costUsd, language)}
              </td>
              <td className={`${tdClass} text-xs whitespace-nowrap text-ink-500 dark:text-ink-400`}>
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
