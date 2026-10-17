import { useState } from 'react';
import { BookOpenText } from 'lucide-react';
import { useSkillsQuery, type SkillSummary } from '../../api/skills.js';
import { useI18n } from '../../i18n/context.js';
import { DEFAULT_SKILL_LIMITS } from './skill-files.js';
import { SkillDeleteDialog, SkillEditDialog } from './SkillDialogs.js';
import { SkillRow } from './SkillRow.js';
import { SkillTemplates } from './SkillTemplates.js';
import { SkillUploadForm } from './SkillUploadForm.js';
import { useBotNames } from './useBotNames.js';

export interface SkillsCardProps {
  workspaceId: string;
  isMember: boolean;
}

const COLUMNS = 5;

type Dialog = { kind: 'edit' | 'delete'; skill: SkillSummary } | null;

/**
 * «مهارات المراجعة» (ADR-0034): the workspace's Markdown skills, with their size, last update and
 * the bots using them. Admins upload, add from a template, edit and delete; members only read.
 */
export function SkillsCard({ workspaceId, isMember }: SkillsCardProps) {
  const { t } = useI18n();
  const { data, isLoading } = useSkillsQuery(workspaceId);
  const botNames = useBotNames(workspaceId);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const skills = data?.skills ?? [];
  const limits = data?.limits ?? DEFAULT_SKILL_LIMITS;
  const atLimit = skills.length >= limits.maxSkills;

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <BookOpenText className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('skillsCardTitle')}</h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{t('skillsCardDesc')}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="py-4 text-sm text-ink-400">{t('loading')}</div>
      ) : skills.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-500 dark:text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-[10px]">
          {t('skillsEmpty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead>
              <tr className="border-b border-ink-200 dark:border-ink-800 text-[11px] text-ink-500 dark:text-ink-400">
                <th className="py-2.5 px-3 text-start font-semibold">{t('skillsColName')}</th>
                <th className="py-2.5 px-3 text-start font-semibold">{t('skillsColSize')}</th>
                <th className="py-2.5 px-3 text-start font-semibold">{t('skillsColUpdated')}</th>
                <th className="py-2.5 px-3 text-start font-semibold">{t('skillsColUsedBy')}</th>
                <th className="py-2.5 px-3 text-end font-semibold">{t('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800/50">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  workspaceId={workspaceId}
                  skill={skill}
                  maxTokens={limits.maxTokens}
                  botNames={botNames(skill.usedBy)}
                  isMember={isMember}
                  previewOpen={previewId === skill.id}
                  onTogglePreview={() => setPreviewId((open) => (open === skill.id ? null : skill.id))}
                  onEdit={() => setDialog({ kind: 'edit', skill })}
                  onDelete={() => setDialog({ kind: 'delete', skill })}
                  columns={COLUMNS}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isMember && (
        <div className="flex flex-col gap-5 pt-4 border-t border-ink-100 dark:border-ink-800">
          {atLimit && (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
              {t('skillsLimitReached', { max: limits.maxSkills })}
            </p>
          )}
          <SkillUploadForm workspaceId={workspaceId} limits={limits} disabled={atLimit} />
          <SkillTemplates
            workspaceId={workspaceId}
            existingNames={skills.map((s) => s.name)}
            limits={limits}
            disabled={atLimit}
          />
        </div>
      )}

      {dialog?.kind === 'edit' && (
        <SkillEditDialog workspaceId={workspaceId} skill={dialog.skill} limits={limits} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <SkillDeleteDialog
          workspaceId={workspaceId}
          skill={dialog.skill}
          botNames={botNames(dialog.skill.usedBy)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
