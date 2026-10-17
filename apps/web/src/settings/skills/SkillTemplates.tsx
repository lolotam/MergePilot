import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { useCreateSkillMutation, type SkillsResponse } from '../../api/skills.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { freeSkillName, skillErrorText } from './skill-files.js';
import { SKILL_TEMPLATES, type SkillTemplate } from './templates.js';

export interface SkillTemplatesProps {
  workspaceId: string;
  /** The names already in the workspace, so a template gets a free name. */
  existingNames: readonly string[];
  limits: SkillsResponse['limits'];
  disabled: boolean;
}

/** Admin only: "Add from template" creates an ordinary, editable skill from a bundled template (ADR-0034 §11). */
export function SkillTemplates({ workspaceId, existingNames, limits, disabled }: SkillTemplatesProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const create = useCreateSkillMutation(workspaceId);
  const [error, setError] = useState<string | null>(null);

  const add = async (template: SkillTemplate) => {
    setError(null);
    const name = freeSkillName(t(template.nameKey), existingNames, limits.maxNameLength);
    try {
      await create.mutateAsync({ name, content: template.content });
      showToast(t('skillsTemplateAdded', { name }), 'success');
    } catch (err) {
      setError(skillErrorText(err, t, limits.maxTokens));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900 dark:text-ink-100">{t('skillsTemplatesTitle')}</h3>
      <p className="text-xs text-ink-500 dark:text-ink-400">{t('skillsTemplatesDesc')}</p>
      <div className="flex flex-wrap gap-2">
        {SKILL_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => void add(template)}
            disabled={disabled || create.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/40 dark:hover:bg-brand-950/80 text-brand-700 dark:text-brand-300 border-brand-200 dark:border-brand-800 disabled:opacity-50 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            {t(template.nameKey)}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
