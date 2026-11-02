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

/**
 * The id of the next row of a list.
 *
 * The id is a counter and never a value of the row: a row that is removed
 * from the middle of the list takes its id with it, so the browser removes
 * that row and keeps the value and the focus of the other ones.
 */
let lastRowId = 0;

export function nextRowId(): number {
  lastRowId += 1;
  return lastRowId;
}

/** One crawl or blocked path rule, as the form holds it. */
export interface PathRuleDraft {
  /** The stable id of the row. */
  id: number;
  path: string;
  kind: 'exact' | 'prefix';
}

/** One parameterized or active path rule, as the form holds it. */
export interface ParameterRuleDraft {
  /** The stable id of the row. */
  id: number;
  path: string;
  /** The parameter names, separated by a space. */
  parameters: string;
}

/** One file path, as the form holds it. */
export interface PathDraft {
  /** The stable id of the row. */
  id: number;
  path: string;
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
        <div key={rule.id} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="text"
            dir="ltr"
            value={rule.path}
            onChange={(e) =>
              onChange(rules.map((entry) => (entry.id === rule.id ? { ...entry, path: e.target.value } : entry)))
            }
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <select
            aria-label={t('webscanPathKindLabel')}
            value={rule.kind}
            onChange={(e) =>
              onChange(
                rules.map((entry) =>
                  entry.id === rule.id
                    ? { ...entry, kind: e.target.value === 'prefix' ? 'prefix' : 'exact' }
                    : entry,
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
            onClick={() => onChange(rules.filter((entry) => entry.id !== rule.id))}
            className={removeButtonClass}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { id: nextRowId(), path: '', kind: 'exact' }])}
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
        <div key={rule.id} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="text"
            dir="ltr"
            value={rule.path}
            onChange={(e) =>
              onChange(
                rules.map((entry) =>
                  entry.id === rule.id ? { ...entry, path: e.target.value } : entry,
                ),
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
                rules.map((entry) =>
                  entry.id === rule.id ? { ...entry, parameters: e.target.value } : entry,
                ),
              )
            }
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <button
            type="button"
            aria-label={`${t('webscanRemoveRule')}: ${rule.path || index + 1}`}
            onClick={() => onChange(rules.filter((entry) => entry.id !== rule.id))}
            className={removeButtonClass}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { id: nextRowId(), path: '', parameters: '' }])}
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
  paths: PathDraft[];
  onChange: (paths: PathDraft[]) => void;
}

export function FilePathsField({ label, paths, onChange }: FilePathsFieldProps) {
  const { t } = useI18n();

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-semibold text-ink-800 dark:text-ink-100">{label}</legend>
      {paths.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={label}
            type="text"
            dir="ltr"
            value={row.path}
            onChange={(e) =>
              onChange(paths.map((entry) => (entry.id === row.id ? { ...entry, path: e.target.value } : entry)))
            }
            className={`${inputClass} flex-1 min-w-[10rem]`}
          />
          <button
            type="button"
            aria-label={`${t('webscanRemoveRule')}: ${row.path || index + 1}`}
            onClick={() => onChange(paths.filter((entry) => entry.id !== row.id))}
            className={removeButtonClass}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...paths, { id: nextRowId(), path: '' }])}
        className="inline-flex items-center gap-1 self-start px-3 py-1.5 text-xs font-semibold rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>{t('webscanAddRule')}</span>
      </button>
    </fieldset>
  );
}
