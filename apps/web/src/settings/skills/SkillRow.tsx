import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { useSkillContentQuery, type SkillSummary } from '../../api/skills.js';
import { useI18n } from '../../i18n/context.js';

export interface SkillRowProps {
  workspaceId: string;
  skill: SkillSummary;
  maxTokens: number;
  botNames: readonly string[];
  isMember: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The table's column count, for the preview row. */
  columns: number;
}

const actionClass =
  'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 focus:ring-2 focus:ring-brand-500 focus:outline-hidden';

/** A skill's content as plain text: never rendered as Markdown or HTML (ADR-0034 §2). */
function SkillPreview({ workspaceId, skill }: { workspaceId: string; skill: SkillSummary }) {
  const { t } = useI18n();
  const query = useSkillContentQuery(workspaceId, skill.id, true);
  if (query.isError) {
    return <p role="alert" className="text-xs text-red-500">{query.error.message || t('error')}</p>;
  }
  if (!query.data) return <p className="text-xs text-ink-400">{t('skillsPreviewLoading')}</p>;
  return (
    <pre
      dir="auto"
      aria-label={t('skillsPreviewOf', { name: skill.name })}
      className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 rounded-[10px] bg-ink-50 dark:bg-ink-950 border border-ink-200 dark:border-ink-800 text-[11px] leading-relaxed font-mono text-ink-800 dark:text-ink-200"
    >
      {query.data.skill.content}
    </pre>
  );
}

/** One skill in the list: name, size against the cap, last update, the bots using it, and actions. */
export function SkillRow(props: SkillRowProps) {
  const { workspaceId, skill, maxTokens, botNames, isMember, previewOpen, onTogglePreview, onEdit, onDelete, columns } = props;
  const { t, language } = useI18n();
  return (
    <>
      <tr className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 align-top">
        <td dir="auto" className="py-2.5 px-3 font-semibold text-ink-900 dark:text-ink-100 break-words max-w-[14rem]">
          {skill.name}
        </td>
        <td className="py-2.5 px-3 text-ink-500 dark:text-ink-400 whitespace-nowrap tabular-nums">
          {t('skillsSize', { size: skill.sizeTokens.toLocaleString(), max: maxTokens.toLocaleString() })}
        </td>
        <td className="py-2.5 px-3 text-ink-500 dark:text-ink-400 whitespace-nowrap">
          {new Date(skill.updatedAt).toLocaleDateString()}
        </td>
        <td className="py-2.5 px-3 text-ink-700 dark:text-ink-300">
          {botNames.length > 0 ? botNames.join(language === 'ar' ? '، ' : ', ') : <span className="text-ink-400">{t('skillsUnused')}</span>}
        </td>
        <td className="py-2.5 px-3 text-end">
          <div role="group" aria-label={t('skillsActionsFor', { name: skill.name })} className="inline-flex flex-wrap justify-end gap-1.5">
            <button type="button" onClick={onTogglePreview} aria-expanded={previewOpen} className={actionClass}>
              {previewOpen ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {previewOpen ? t('skillsHidePreview') : t('skillsPreview')}
            </button>
            {!isMember && (
              <>
                <button type="button" onClick={onEdit} className={actionClass}>
                  <Pencil className="w-3 h-3" />
                  {t('skillsEdit')}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className={`${actionClass} text-red-600 dark:text-red-400 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/50`}
                >
                  <Trash2 className="w-3 h-3" />
                  {t('skillsDelete')}
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {previewOpen && (
        <tr>
          <td colSpan={columns} className="px-3 pb-3">
            <SkillPreview workspaceId={workspaceId} skill={skill} />
          </td>
        </tr>
      )}
    </>
  );
}
