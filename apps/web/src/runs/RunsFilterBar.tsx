import { useState, useEffect, useRef } from 'react';
import { Search, X, Filter } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

interface RunsFilterBarProps {
  repos: string[];
  selectedRepos: string[];
  onSelectRepos: (repos: string[]) => void;
  selectedStatuses: string[];
  onSelectStatuses: (statuses: string[]) => void;
  fromDate: string;
  toDate: string;
  onDateChange: (from: string, to: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
}

const ALL_STATUSES = ['completed', 'running', 'queued', 'skipped', 'failed'] as const;

export function RunsFilterBar({
  repos,
  selectedRepos,
  onSelectRepos,
  selectedStatuses,
  onSelectStatuses,
  fromDate,
  toDate,
  onDateChange,
  searchQuery,
  onSearchChange,
  onClearFilters,
  hasActiveFilters,
}: RunsFilterBarProps) {
  const { t } = useI18n();
  const [searchInput, setSearchInput] = useState(searchQuery);
  const [isRepoOpen, setIsRepoOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);

  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Sync internal search input with prop (e.g. on clear)
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== searchQuery) {
        onSearchChange(searchInput);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, searchQuery, onSearchChange]);

  // Close dropdowns on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setIsRepoOpen(false);
      }
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setIsStatusOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleRepo = (repo: string) => {
    if (selectedRepos.includes(repo)) {
      onSelectRepos(selectedRepos.filter((r) => r !== repo));
    } else {
      onSelectRepos([...selectedRepos, repo]);
    }
  };

  const toggleStatus = (status: string) => {
    if (selectedStatuses.includes(status)) {
      onSelectStatuses(selectedStatuses.filter((s) => s !== status));
    } else {
      onSelectStatuses([...selectedStatuses, status]);
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed':
        return t('statusCompleted');
      case 'running':
        return t('statusRunning');
      case 'queued':
        return t('statusQueued');
      case 'skipped':
        return t('statusSkipped');
      case 'failed':
        return t('statusFailed');
      default:
        return status;
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search Input */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            maxLength={200}
            placeholder={t('searchRunsPlaceholder')}
            className="w-full ps-9 pe-3 py-1.5 text-xs bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-md text-ink-900 dark:text-ink-100 placeholder:text-ink-400 focus:outline-hidden focus:ring-1 focus:ring-brand-500"
          />
        </div>

        {/* Repositories Dropdown */}
        <div className="relative" ref={repoDropdownRef}>
          <button
            type="button"
            onClick={() => setIsRepoOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
              selectedRepos.length > 0
                ? 'bg-brand-50 text-brand-900 border-brand-300 dark:bg-brand-950/50 dark:text-brand-300 dark:border-brand-700'
                : 'bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-300 border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-700'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>
              {selectedRepos.length === 0
                ? t('filterRepos')
                : `${t('filterRepos')} (${selectedRepos.length})`}
            </span>
          </button>
          {isRepoOpen && (
            <div className="absolute start-0 mt-1 w-56 p-2 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded-lg shadow-lg z-30 max-h-60 overflow-y-auto">
              {repos.length === 0 ? (
                <div className="p-2 text-xs text-ink-400 text-center">{t('allRepos')}</div>
              ) : (
                repos.map((repo) => (
                  <label
                    key={repo}
                    className="flex items-center gap-2 p-1.5 text-xs rounded hover:bg-ink-50 dark:hover:bg-ink-800 cursor-pointer text-ink-800 dark:text-ink-200"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRepos.includes(repo)}
                      onChange={() => toggleRepo(repo)}
                      className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="truncate font-mono" dir="ltr">
                      {repo}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>

        {/* Status Dropdown */}
        <div className="relative" ref={statusDropdownRef}>
          <button
            type="button"
            onClick={() => setIsStatusOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
              selectedStatuses.length > 0
                ? 'bg-brand-50 text-brand-900 border-brand-300 dark:bg-brand-950/50 dark:text-brand-300 dark:border-brand-700'
                : 'bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-300 border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-700'
            }`}
          >
            <span>
              {selectedStatuses.length === 0
                ? t('filterStatus')
                : `${t('filterStatus')} (${selectedStatuses.length})`}
            </span>
          </button>
          {isStatusOpen && (
            <div className="absolute start-0 mt-1 w-44 p-2 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded-lg shadow-lg z-30">
              {ALL_STATUSES.map((status) => (
                <label
                  key={status}
                  className="flex items-center gap-2 p-1.5 text-xs rounded hover:bg-ink-50 dark:hover:bg-ink-800 cursor-pointer text-ink-800 dark:text-ink-200"
                >
                  <input
                    type="checkbox"
                    checked={selectedStatuses.includes(status)}
                    onChange={() => toggleStatus(status)}
                    className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>{getStatusLabel(status)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Date From & To */}
        <div className="flex items-center gap-1 text-xs">
          <input
            type="date"
            aria-label={t('filterDateFrom')}
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => onDateChange(e.target.value, toDate)}
            className="px-2.5 py-1.5 bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-md text-ink-800 dark:text-ink-200 text-xs focus:ring-1 focus:ring-brand-500"
          />
          <span className="text-ink-400">—</span>
          <input
            type="date"
            aria-label={t('filterDateTo')}
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => onDateChange(fromDate, e.target.value)}
            className="px-2.5 py-1.5 bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-md text-ink-800 dark:text-ink-200 text-xs focus:ring-1 focus:ring-brand-500"
          />
        </div>

        {/* Clear Filters Button */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 rounded-md transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            <span>{t('clearFilters')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
