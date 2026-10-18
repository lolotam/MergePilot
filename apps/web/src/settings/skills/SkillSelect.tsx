import { useSkillsQuery } from '../../api/skills.js';
import { useI18n } from '../../i18n/context.js';
import { fieldClass, labelClass } from '../providers.js';

export interface SkillSelectProps {
  id: string;
  workspaceId: string;
  /** The chosen skill id; null = Default (the core prompt only). */
  value: string | null;
  onChange: (skillId: string | null) => void;
  disabled?: boolean;
  /** The name of this bot's skill that was deleted (ADR-0034 §4), shown while the bot is on Default. */
  removedName?: string | null | undefined;
}

const DEFAULT_VALUE = '';

/** A bot's review skill: "Default (core prompt only)" or one of the workspace's skills by name. */
export function SkillSelect({ id, workspaceId, value, onChange, disabled = false, removedName }: SkillSelectProps) {
  const { t } = useI18n();
  const skills = useSkillsQuery(workspaceId).data?.skills ?? [];
  // A chosen skill missing from a stale list still shows, so a save never drops it silently.
  const unknownChoice = value !== null && !skills.some((s) => s.id === value);

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {t('skillSelectLabel')}
      </label>
      <select
        id={id}
        dir="auto"
        value={value ?? DEFAULT_VALUE}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === DEFAULT_VALUE ? null : e.target.value)}
        className={fieldClass}
      >
        <option value={DEFAULT_VALUE}>{t('skillSelectDefault')}</option>
        {skills.map((skill) => (
          <option key={skill.id} value={skill.id}>
            {skill.name}
          </option>
        ))}
        {unknownChoice && <option value={value}>{t('loading')}</option>}
      </select>
      <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('skillSelectHint')}</p>
      {removedName && value === null && (
        <p
          role="status"
          dir="auto"
          className="mt-2 p-2.5 rounded-[10px] bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-xs"
        >
          {t('skillRemovedNote', { name: removedName })}
        </p>
      )}
    </div>
  );
}
