import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/context.js';
import { inputClass } from './components.js';

/**
 * The scope controls of the site form (ADR-0052 sections 2 and 5).
 *
 * The scope is empty by default: no crawl, no parameterized query and no
 * active probe until the administrator authorizes a path. The groups are
 * fieldsets, so the keyboard and the screen reader know which rule belongs to
 * which list.
 */

/** One crawl or blocked path rule, as the form holds it. */
export interface PathRuleDraft {
  path: string;
  kind: 'exact' | 'prefix';
}

/** One parameterized or active path rule, as the form holds it. */
export interface ParameterRuleDraft {
  path: string;
  /** The parameter names, separated by a space. */
  parameters: string;
}

const removeButtonClass =
  'p-1.5 rounded-full text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors';

export interface PathRulesFieldProps {
  label: string;
  rules: PathRuleDraft[];
  onChange: (rules: PathRuleDraft[]) => void;
}

export function PathRulesField({ label, rules, onChange }: PathRulesFieldProps) {
  const { t } = useI18n();

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-semibold text-ink-800 dark:text-ink-100">{label}</legend>
      {rules.map((rule, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="text"
            dir="ltr"
            value={rule.path}
            onChange={(e) =>
              onChange(rules.map((entry, i) => (i === index ? { ...entry, path: e.target.value } : entry)))
            }
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <select
            aria-label={t('webscanPathKindLabel')}
            value={rule.kind}
            onChange={(e) =>
              onChange(
                rules.map((entry, i) =>
                  i === index ? { ...entry, kind: e.target.value === 'prefix' ? 'prefix' : 'exact' } : entry,
                ),
              )
            }
            className={`${inputClass} w-32`}
          >
            <option value="exact">{t('webscanPathKindExact')}</option>
            <option value="prefix">{t('webscanPathKindPrefix')}</option>
          </select>
          <button
            type="button"
            aria-label={`${t('webscanRemoveRule')}: ${rule.path || index + 1}`}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
            className={removeButtonClass}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { path: '', kind: 'exact' }])}
        className="inline-flex items-center gap-1 self-start px-3 py-1.5 text-xs font-semibold rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>{t('webscanAddRule')}</span>
      </button>
    </fieldset>
  );
}

export interface ParameterRulesFieldProps {
  label: string;
  rules: ParameterRuleDraft[];
  onChange: (rules: ParameterRuleDraft[]) => void;
}

export function ParameterRulesField({ label, rules, onChange }: ParameterRulesFieldProps) {
  const { t } = useI18n();

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-semibold text-ink-800 dark:text-ink-100">{label}</legend>
      {rules.map((rule, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="text"
            dir="ltr"
            value={rule.path}
            onChange={(e) =>
              onChange(
                rules.map((entry, i) => (i === index ? { ...entry, path: e.target.value } : entry)),
              )
            }
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <input
            aria-label={t('webscanParametersLabel')}
            type="text"
            dir="ltr"
            value={rule.parameters}
            onChange={(e) =>
              onChange(
                rules.map((entry, i) =>
                  i === index ? { ...entry, parameters: e.target.value } : entry,
                ),
              )
            }
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <button
            type="button"
            aria-label={`${t('webscanRemoveRule')}: ${rule.path || index + 1}`}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
            className={removeButtonClass}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { path: '', parameters: '' }])}
        className="inline-flex items-center gap-1 self-start px-3 py-1.5 text-xs font-semibold rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>{t('webscanAddRule')}</span>
      </button>
    </fieldset>
  );
}

export interface FilePathsFieldProps {
  label: string;
  paths: string[];
  onChange: (paths: string[]) => void;
}

export function FilePathsField({ label, paths, onChange }: FilePathsFieldProps) {
  const { t } = useI18n();

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-semibold text-ink-800 dark:text-ink-100">{label}</legend>
      {paths.map((path, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="text"
            dir="ltr"
            value={path}
            onChange={(e) => onChange(paths.map((entry, i) => (i === index ? e.target.value : entry)))}
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <button
            type="button"
            aria-label={`${t('webscanRemoveRule')}: ${path || index + 1}`}
            onClick={() => onChange(paths.filter((_, i) => i !== index))}
            className={removeButtonClass}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...paths, ''])}
        className="inline-flex items-center gap-1 self-start px-3 py-1.5 text-xs font-semibold rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>{t('webscanAddRule')}</span>
      </button>
    </fieldset>
  );
}
