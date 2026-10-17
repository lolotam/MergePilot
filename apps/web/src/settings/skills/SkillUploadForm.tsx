import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { SkillsResponse } from '../../api/skills.js';
import { useCreateSkillMutation } from '../../api/skills.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { fieldClass, labelClass } from '../providers.js';
import { nameFromFile, readSkillFile, SKILL_FILE_ACCEPT, skillErrorText, skillNameError } from './skill-files.js';

export interface SkillUploadFormProps {
  workspaceId: string;
  limits: SkillsResponse['limits'];
  disabled: boolean;
}

/** Admin only: a name and a Markdown file, checked here first and by the server (ADR-0034 §2). */
export function SkillUploadForm({ workspaceId, limits, disabled }: SkillUploadFormProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const create = useCreateSkillMutation(workspaceId);
  const [name, setName] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new key clears the file input after an upload.
  const [fileKey, setFileKey] = useState(0);

  // Only the latest pick counts: a slow earlier read must not replace it, and no upload is sent
  // while it is still being read.
  const [reading, setReading] = useState(false);
  const latestPick = useRef(0);

  const handleFile = async (file: File | undefined) => {
    const pick = ++latestPick.current;
    setError(null);
    setContent(null);
    if (!file) return setReading(false);
    setReading(true);
    const read = await readSkillFile(file, limits.maxTokens, t);
    if (pick !== latestPick.current) return;
    setReading(false);
    if (!read.ok) return setError(read.error);
    setContent(read.content);
    if (!name.trim()) setName(nameFromFile(file.name, limits.maxNameLength));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reading) return;
    const problem = skillNameError(name, limits.maxNameLength, t) ?? (content === null ? t('skillsFileRequired') : null);
    if (problem || content === null) return setError(problem);
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), content });
      showToast(t('skillsUploaded'), 'success');
      setName('');
      setContent(null);
      setFileKey((k) => k + 1);
    } catch (err) {
      setError(skillErrorText(err, t, limits.maxTokens));
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-ink-900 dark:text-ink-100">{t('skillsUploadTitle')}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label htmlFor="skill-upload-name" className={labelClass}>
            {t('skillsNameLabel')}
          </label>
          <input
            id="skill-upload-name"
            type="text"
            dir="auto"
            value={name}
            maxLength={limits.maxNameLength}
            disabled={disabled}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="skill-upload-file" className={labelClass}>
            {t('skillsFileLabel')}
          </label>
          <input
            key={fileKey}
            id="skill-upload-file"
            type="file"
            accept={SKILL_FILE_ACCEPT}
            disabled={disabled}
            onChange={(e) => void handleFile(e.target.files?.[0])}
            className="block w-full text-xs text-ink-700 dark:text-ink-300 py-1.5"
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={disabled || create.isPending || reading}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
        >
          <Upload className="w-3.5 h-3.5" />
          {create.isPending ? t('skillsUploading') : t('skillsUploadButton')}
        </button>
      </div>
    </form>
  );
}
