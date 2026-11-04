import { useId } from 'react';
import type { WebScanSiteDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { inputClass } from './components.js';

/**
 * The picker of the site the scan panels work on.
 *
 * The host name is the identity of a site in the scanner: the dashboard never
 * shows a target with a path or a query.
 */
export interface SiteSelectProps {
  sites: WebScanSiteDto[];
  value: string | undefined;
  onChange: (siteId: string) => void;
  disabled?: boolean;
}

export function SiteSelect({ sites, value, onChange, disabled = false }: SiteSelectProps) {
  const { t } = useI18n();
  const selectId = useId();

  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={selectId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
        {t('webscanSelectSiteLabel')}
      </label>
      <select
        id={selectId}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value !== '') onChange(event.target.value);
        }}
        className={`${inputClass} sm:w-72`}
      >
        <option value="">{t('webscanSelectSitePlaceholder')}</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.hostname}
          </option>
        ))}
      </select>
    </div>
  );
}
