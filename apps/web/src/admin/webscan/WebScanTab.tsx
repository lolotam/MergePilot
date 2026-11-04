import { useId, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n/context.js';
import { AuditPanel } from './AuditPanel.js';
import { ExceptionsPanel } from './ExceptionsPanel.js';
import { ScanPanel } from './ScanPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { SitesPanel } from './SitesPanel.js';
import { WebScanSelectionProvider } from './selection.js';

/**
 * The sections of the website scan area (ADR-0052 section 12).
 *
 * The sub-navigation follows the tabs of the admin page: a `tablist` with the
 * arrow keys, mirrored in RTL. The site the scan sections work on is kept
 * while the administrator moves between them, so the scan, the findings and
 * the exceptions always belong to the same site.
 */
const SECTIONS = [
  { id: 'settings', label: 'webscanSectionSettings', Panel: SettingsPanel },
  { id: 'sites', label: 'webscanSectionSites', Panel: SitesPanel },
  { id: 'scans', label: 'webscanSectionScans', Panel: ScanPanel },
  { id: 'exceptions', label: 'webscanSectionExceptions', Panel: ExceptionsPanel },
  { id: 'audit', label: 'webscanSectionAudit', Panel: AuditPanel },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function WebScanTab() {
  const { t, dir } = useI18n();
  const baseId = useId();
  const [active, setActive] = useState<SectionId>('settings');

  const activeIndex = SECTIONS.findIndex((section) => section.id === active);
  const ActivePanel = SECTIONS[activeIndex]?.Panel ?? SettingsPanel;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (event.key !== forward && event.key !== backward) return;
    event.preventDefault();
    const step = event.key === forward ? 1 : -1;
    const next = SECTIONS[(activeIndex + step + SECTIONS.length) % SECTIONS.length];
    if (next) {
      setActive(next.id);
      document.getElementById(`${baseId}-section-${next.id}`)?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label={t('webscanSubNavLabel')}
        onKeyDown={onKeyDown}
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {SECTIONS.map((section) => {
          const selected = section.id === active;
          return (
            <button
              key={section.id}
              id={`${baseId}-section-${section.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${section.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(section.id)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${
                selected
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                  : 'text-ink-600 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-100 hover:bg-ink-100/60 dark:hover:bg-ink-800/60'
              }`}
            >
              {t(section.label)}
            </button>
          );
        })}
      </div>

      <div
        id={`${baseId}-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-section-${active}`}
        className="min-w-0"
      >
        <WebScanSelectionProvider>
          <ActivePanel />
        </WebScanSelectionProvider>
      </div>
    </div>
  );
}

export default WebScanTab;
