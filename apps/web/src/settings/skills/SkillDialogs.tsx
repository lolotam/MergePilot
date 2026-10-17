import { useState } from 'react';
import { useDeleteSkillMutation, useUpdateSkillMutation, type SkillsResponse, type SkillSummary } from '../../api/skills.js';
import { Modal } from '../../components/Modal.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { fieldClass, labelClass } from '../providers.js';
import { readSkillFile, SKILL_FILE_ACCEPT, skillErrorText, skillNameError } from './skill-files.js';

const cancelClass =
  'px-4 py-2 rounded-full text-xs font-semibold text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800';

export interface SkillEditDialogProps {
  workspaceId: string;
  skill: SkillSummary;
  limits: SkillsResponse['limits'];
  onClose: () => void;
}

/** Admin only: rename a skill and/or replace its content with a new Markdown file. */
export function SkillEditDialog({ workspaceId, skill, limits, onClose }: SkillEditDialogProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const update = useUpdateSkillMutation(workspaceId);
  const [name, setName] = useState(skill.name);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    setError(null);
    setContent(null);
    if (!file) return;
    const read = await readSkillFile(file, limits.maxTokens, t);
    if (read.ok) setContent(read.content);
    else setError(read.error);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = skillNameError(name, limits.maxNameLength, t);
    if (problem) return setError(problem);
    const renamed = name.trim() !== skill.name;
    if (!renamed && content === null) return setError(t('skillsNothingChanged'));
    try {
      await update.mutateAsync({
        skillId: skill.id,
        body: { ...(renamed ? { name: name.trim() } : {}), ...(content !== null ? { content } : {}) },
      });
      showToast(t('skillsSaved'), 'success');
      onClose();
    } catch (err) {
      setError(skillErrorText(err, t, limits.maxTokens));
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('skillsEditTitle', { name: skill.name })} description={t('skillsEditDesc')}>
      <form onSubmit={handleSave} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="skill-edit-name" className={labelClass}>
            {t('skillsNameLabel')}
          </label>
          <input
            id="skill-edit-name"
            type="text"
            dir="auto"
            value={name}
            maxLength={limits.maxNameLength}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="skill-edit-file" className={labelClass}>
            {t('skillsReplaceFileLabel')}
          </label>
          <input
            id="skill-edit-file"
            type="file"
            accept={SKILL_FILE_ACCEPT}
            onChange={(e) => void handleFile(e.target.files?.[0])}
            className="block w-full text-xs text-ink-700 dark:text-ink-300"
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={cancelClass}>
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={update.isPending}
            className="px-4 py-2 rounded-full text-xs font-semibold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
          >
            {update.isPending ? t('saving') : t('skillsSave')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface SkillDeleteDialogProps {
  workspaceId: string;
  skill: SkillSummary;
  /** The names of the bots using the skill (from its `usedBy` slots). */
  botNames: readonly string[];
  onClose: () => void;
}

/**
 * Admin only: the in-page delete confirm. When bots use the skill it names them and says they
 * fall back to the core prompt and that their next review of each open PR is a full one (ADR-0034 §4).
 */
export function SkillDeleteDialog({ workspaceId, skill, botNames, onClose }: SkillDeleteDialogProps) {
  const { t, language } = useI18n();
  const { showToast } = useToast();
  const remove = useDeleteSkillMutation(workspaceId);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    try {
      await remove.mutateAsync(skill.id);
      showToast(t('skillsDeleted'), 'success');
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('error'));
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('skillsDeleteTitle', { name: skill.name })}
      description={botNames.length > 0 ? t('skillsDeleteUsed', { bots: botNames.join(language === 'ar' ? '، ' : ', ') }) : t('skillsDeleteUnused')}
    >
      {error && (
        <p role="alert" className="mb-3 text-xs text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cancelClass}>
          {t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={remove.isPending}
          className="px-4 py-2 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
        >
          {t('delete')}
        </button>
      </div>
    </Modal>
  );
}
