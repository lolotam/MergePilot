import { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FileCode,
  Search,
  Filter,
  CheckCircle2,
} from 'lucide-react';
import type { ReviewRunFinding } from '../api/client.js';
import { useI18n } from '../i18n/context.js';

interface RunFindingsListProps {
  findings: ReviewRunFinding[];
  outOfDiff?: ReviewRunFinding[] | undefined;
}

export function RunFindingsList({ findings, outOfDiff = [] }: RunFindingsListProps) {
  const { t } = useI18n();

  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  // Filter in-diff findings
  const filteredFindings = useMemo(() => {
    return findings.filter((f) => {
      if (severityFilter !== 'all' && f.severity !== severityFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchPath = f.path.toLowerCase().includes(q);
        const matchTitle = f.title.toLowerCase().includes(q);
        const matchBody = f.body.toLowerCase().includes(q);
        if (!matchPath && !matchTitle && !matchBody) return false;
      }
      return true;
    });
  }, [findings, severityFilter, searchQuery]);

  // Filter out-of-diff findings
  const filteredOutOfDiff = useMemo(() => {
    return outOfDiff.filter((f) => {
      if (severityFilter !== 'all' && f.severity !== severityFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchPath = f.path.toLowerCase().includes(q);
        const matchTitle = f.title.toLowerCase().includes(q);
        const matchBody = f.body.toLowerCase().includes(q);
        if (!matchPath && !matchTitle && !matchBody) return false;
      }
      return true;
    });
  }, [outOfDiff, severityFilter, searchQuery]);

  // Group by directory -> file
  const groupedFindings = useMemo(() => {
    const dirMap = new Map<string, Map<string, ReviewRunFinding[]>>();

    for (const f of filteredFindings) {
      const normalizedPath = f.path.replace(/\\/g, '/');
      const lastSlash = normalizedPath.lastIndexOf('/');
      const dirName = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '.';
      const fileName = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;

      if (!dirMap.has(dirName)) {
        dirMap.set(dirName, new Map());
      }
      const fileMap = dirMap.get(dirName)!;
      if (!fileMap.has(fileName)) {
        fileMap.set(fileName, []);
      }
      fileMap.get(fileName)!.push(f);
    }

    return dirMap;
  }, [filteredFindings]);

  const toggleDir = (dir: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [dir]: !prev[dir] }));
  };

  const toggleFile = (key: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleAll = (collapse: boolean) => {
    const nextDirs: Record<string, boolean> = {};
    const nextFiles: Record<string, boolean> = {};
    for (const [dir, files] of groupedFindings.entries()) {
      nextDirs[dir] = collapse;
      for (const fileName of files.keys()) {
        nextFiles[`${dir}/${fileName}`] = collapse;
      }
    }
    setCollapsedDirs(nextDirs);
    setCollapsedFiles(nextFiles);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Controls: Search, Severity Filter, Expand/Collapse */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-ink-50/50 dark:bg-ink-800/30 rounded-[10px] border border-ink-200 dark:border-ink-700">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchFindingsPlaceholder')}
              className="w-full ps-9 pe-3 py-1.5 text-xs bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded-md text-ink-900 dark:text-ink-100 placeholder:text-ink-400 focus:outline-hidden focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-ink-500" />
            <select
              aria-label={t('filterSeverity')}
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded-md text-ink-800 dark:text-ink-200 focus:ring-1 focus:ring-brand-500"
            >
              <option value="all">{t('allSeverities')}</option>
              <option value="critical">{t('severityCritical')}</option>
              <option value="high">{t('severityHigh')}</option>
              <option value="medium">{t('severityMedium')}</option>
              <option value="low">{t('severityLow')}</option>
              <option value="info">{t('severityInfo')}</option>
            </select>
          </div>
        </div>

        {groupedFindings.size > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => toggleAll(false)}
              className="px-2 py-1 text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-700 rounded transition-colors"
            >
              {t('expandAll')}
            </button>
            <span className="text-ink-300">|</span>
            <button
              type="button"
              onClick={() => toggleAll(true)}
              className="px-2 py-1 text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-700 rounded transition-colors"
            >
              {t('collapseAll')}
            </button>
          </div>
        )}
      </div>

      {/* In-diff Findings list */}
      {findings.length === 0 ? (
        <div className="p-8 text-center bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 text-sm text-ink-500">
          <CheckCircle2 className="w-8 h-8 mx-auto text-green-500 mb-2" />
          <p className="font-semibold text-ink-800 dark:text-ink-200">{t('noFindings')}</p>
        </div>
      ) : filteredFindings.length === 0 ? (
        <div className="p-8 text-center bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 text-xs text-ink-400">
          {t('noFindingsMatchFilter')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {Array.from(groupedFindings.entries()).map(([dirName, filesMap]) => {
            const isDirCollapsed = Boolean(collapsedDirs[dirName]);
            const dirFindingsCount = Array.from(filesMap.values()).reduce(
              (acc, list) => acc + list.length,
              0,
            );

            return (
              <div
                key={dirName}
                className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 overflow-hidden shadow-xs"
              >
                {/* Directory Header */}
                <button
                  type="button"
                  onClick={() => toggleDir(dirName)}
                  className="w-full flex items-center justify-between px-4 py-2.5 bg-ink-50 dark:bg-ink-800/60 hover:bg-ink-100 dark:hover:bg-ink-800 text-start text-xs font-semibold text-ink-800 dark:text-ink-200 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {isDirCollapsed ? (
                      <ChevronRight className="w-4 h-4 text-ink-400 rtl:rotate-180" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-ink-400" />
                    )}
                    <Folder className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                    <span className="font-mono text-xs" dir="ltr">
                      {dirName}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-ink-200 dark:bg-ink-700 text-ink-700 dark:text-ink-300">
                    {dirFindingsCount}
                  </span>
                </button>

                {/* Directory Content (Files) */}
                {!isDirCollapsed && (
                  <div className="divide-y divide-ink-100 dark:divide-ink-800">
                    {Array.from(filesMap.entries()).map(([fileName, fileFindings]) => {
                      const fileKey = `${dirName}/${fileName}`;
                      const isFileCollapsed = Boolean(collapsedFiles[fileKey]);

                      return (
                        <div key={fileName} className="p-3">
                          {/* File Header */}
                          <button
                            type="button"
                            onClick={() => toggleFile(fileKey)}
                            className="w-full flex items-center justify-between p-2 rounded-md hover:bg-ink-50 dark:hover:bg-ink-800/40 text-start text-xs font-medium text-ink-700 dark:text-ink-300 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              {isFileCollapsed ? (
                                <ChevronRight className="w-3.5 h-3.5 text-ink-400 rtl:rotate-180" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5 text-ink-400" />
                              )}
                              <FileCode className="w-3.5 h-3.5 text-ink-500" />
                              <span className="font-mono text-xs font-semibold" dir="ltr">
                                {fileName}
                              </span>
                            </div>
                            <span className="text-[11px] text-ink-400">
                              {fileFindings.length}
                            </span>
                          </button>

                          {/* Findings in File */}
                          {!isFileCollapsed && (
                            <div className="flex flex-col gap-3 mt-2 ps-4">
                              {fileFindings.map((finding, idx) => (
                                <FindingCard
                                  key={`${finding.path}-${finding.line ?? 0}-${idx}`}
                                  finding={finding}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Out-of-diff Findings Section */}
      {outOfDiff.length > 0 && (
        <div className="flex flex-col gap-3 mt-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-800 dark:text-ink-200">
              {t('outOfDiffTitle')}
            </h3>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              {filteredOutOfDiff.length}
            </span>
          </div>
          {filteredOutOfDiff.length === 0 ? (
            <div className="p-4 text-center bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 text-xs text-ink-400">
              {t('noFindingsMatchFilter')}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredOutOfDiff.map((finding, idx) => (
                <div
                  key={`ood-${finding.path}-${idx}`}
                  className="bg-white dark:bg-ink-900 rounded-[10px] border border-amber-200 dark:border-amber-900/60 p-4 shadow-xs"
                >
                  <div className="font-mono text-xs text-ink-600 dark:text-ink-400 mb-2" dir="ltr">
                    {finding.path}
                  </div>
                  <FindingCard finding={finding} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding }: { finding: ReviewRunFinding }) {
  const { t } = useI18n();

  const severityClasses: Record<string, string> = {
    critical: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 border-red-200',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300 border-orange-200',
    medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200',
    low: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200',
    info: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300 border-ink-200',
  };

  const lineRangeText =
    finding.line !== undefined
      ? finding.endLine && finding.endLine !== finding.line
        ? `L${finding.line}-${finding.endLine}`
        : `L${finding.line}`
      : null;

  return (
    <div className="flex flex-col gap-2 p-3.5 bg-ink-50/40 dark:bg-ink-800/20 rounded-lg border border-ink-200 dark:border-ink-700 text-xs">
      {/* Header: Severity, Line Range, Category */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
            severityClasses[finding.severity] ?? severityClasses.info
          }`}
        >
          {finding.severity}
        </span>
        {lineRangeText && (
          <span className="font-mono text-xs text-ink-600 dark:text-ink-400" dir="ltr">
            {lineRangeText}
          </span>
        )}
        {finding.category && (
          <span className="text-[11px] text-ink-400 bg-ink-100 dark:bg-ink-800 px-1.5 py-0.5 rounded">
            {finding.category}
          </span>
        )}
      </div>

      {/* Title */}
      <h4 className="font-semibold text-xs text-ink-900 dark:text-ink-100">{finding.title}</h4>

      {/* Body: Rendered as plain text preserving line breaks */}
      <div className="text-ink-700 dark:text-ink-300 whitespace-pre-wrap leading-relaxed">
        {finding.body}
      </div>

      {/* Suggestion Code Block */}
      {finding.suggestion && (
        <div className="mt-2 flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink-500">
            {t('suggestionLabel')}:
          </span>
          <pre
            className="p-3 bg-ink-950 text-emerald-400 dark:bg-ink-950 dark:text-emerald-300 rounded-md font-mono text-xs overflow-x-auto"
            dir="ltr"
          >
            <code>{finding.suggestion}</code>
          </pre>
        </div>
      )}

      {/* Truncated flag */}
      {finding.truncated && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400 italic">
          [Truncated]
        </span>
      )}
    </div>
  );
}
