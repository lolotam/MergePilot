import { useId, useState, type KeyboardEvent } from 'react';
import { Navigate } from 'react-router';
import { Shield } from 'lucide-react';
import { useMeQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { OverviewTab } from './OverviewTab.js';
import { RunsTab } from './RunsTab.js';
import { UsersTab } from './UsersTab.js';
import { WorkspacesTab } from './WorkspacesTab.js';

const TABS = [
  { id: 'overview', label: 'tabOverview', Panel: OverviewTab },
  { id: 'users', label: 'tabUsers', Panel: UsersTab },
  { id: 'workspaces', label: 'tabWorkspaces', Panel: WorkspacesTab },
  { id: 'runs', label: 'tabRuns', Panel: RunsTab },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Platform operator dashboard. Anyone who is not a platform admin is sent back to `/`. */
export function AdminPage() {
  const { t, dir } = useI18n();
  const baseId = useId();
  const { data: me, isLoading } = useMeQuery();
  const [active, setActive] = useState<TabId>('overview');

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-gray-400">{t('loading')}</div>;
  }
  if (!me?.isPlatformAdmin) {
    return <Navigate to="/" replace />;
  }

  const activeIndex = TABS.findIndex((tab) => tab.id === active);
  const ActivePanel = TABS[activeIndex]?.Panel ?? OverviewTab;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key !== forward && e.key !== backward) return;
    e.preventDefault();
    const step = e.key === forward ? 1 : -1;
    const next = TABS[(activeIndex + step + TABS.length) % TABS.length];
    if (next) {
      setActive(next.id);
      document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
          <Shield className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 dark:text-ink-100">
            {t('adminTitle')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('adminSubtitle')}</p>
        </div>
      </div>

      <div
        role="tablist"
        aria-label={t('adminTitle')}
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-ink-800"
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`${baseId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              className={`px-4 py-2.5 -mb-px border-b-2 text-sm font-medium whitespace-nowrap transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${
                selected
                  ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400'
                  : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              {t(tab.label)}
            </button>
          );
        })}
      </div>

      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${active}`}
        className="min-w-0"
      >
        <ActivePanel />
      </div>
    </div>
  );
}

export default AdminPage;
