import type {
  MAX_SKILL_NAME_LENGTH as SERVER_MAX_NAME,
  MAX_SKILL_TOKENS as SERVER_MAX_TOKENS,
  MAX_WORKSPACE_SKILLS as SERVER_MAX_SKILLS,
  SkillErrorCode,
  SkillsResponse,
} from '@mergepilot/app/contract';
import { ApiClientError } from '../../api/client.js';
import type { I18nKey } from '../../i18n/ar.js';
import type { I18nContextValue } from '../../i18n/context.js';
import { readFileText } from '../read-file-text.js';

// The server's limits (type-checked; the web never imports server runtime code). The GET /skills
// answer is the authority; these only fill in until it loads.
export const DEFAULT_SKILL_LIMITS: SkillsResponse['limits'] = {
  maxSkills: 50 satisfies typeof SERVER_MAX_SKILLS,
  maxTokens: 8000 satisfies typeof SERVER_MAX_TOKENS,
  maxNameLength: 60 satisfies typeof SERVER_MAX_NAME,
};

/** The engine's estimate (`estimateTokens`): ceil(chars / 3.5). */
export const estimateSkillTokens = (text: string): number => Math.ceil(text.length / 3.5);

/** Upload accepts Markdown files only (ADR-0034 §2). */
export const SKILL_FILE_ACCEPT = '.md,.markdown';
const isMarkdownName = (name: string): boolean => /\.(md|markdown)$/i.test(name);

export type SkillFileResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Reads a picked skill file after the client-side checks: Markdown extension and the token cap.
 * The server checks again (and also for text-ness and secrets).
 */
export async function readSkillFile(file: File, maxTokens: number, t: I18nContextValue['t']): Promise<SkillFileResult> {
  if (!isMarkdownName(file.name)) return { ok: false, error: t('skillsFileWrongType') };
  let content: string;
  try {
    content = await readFileText(file);
  } catch {
    return { ok: false, error: t('skillsFileUnreadable') };
  }
  const size = estimateSkillTokens(content);
  if (size > maxTokens) {
    return { ok: false, error: t('skillsFileTooLarge', { size: size.toLocaleString(), max: maxTokens.toLocaleString() }) };
  }
  return { ok: true, content };
}

/** The file name without its Markdown extension, as a default skill name. */
export const nameFromFile = (fileName: string, maxLength: number): string =>
  fileName.replace(/\.(md|markdown)$/i, '').trim().slice(0, maxLength);

/** The name's problem before sending, or null. */
export function skillNameError(name: string, maxLength: number, t: I18nContextValue['t']): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t('skillsNameRequired');
  if (trimmed.length > maxLength) return t('skillsNameTooLong', { max: maxLength });
  return null;
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** `base`, or `base 2`, `base 3`… when a skill already has that name (names are unique ignoring case). */
export function freeSkillName(base: string, existing: readonly string[], maxLength: number): string {
  if (!existing.some((n) => sameName(n, base))) return base;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!existing.some((other) => sameName(other, candidate))) return candidate;
  }
}

const ERROR_KEYS: Record<SkillErrorCode, I18nKey> = {
  skill_name_taken: 'skillErrorNameTaken',
  skill_limit: 'skillErrorLimit',
  skill_empty: 'skillErrorEmpty',
  skill_too_large: 'skillErrorTooLarge',
  skill_not_text: 'skillErrorNotText',
  skill_has_credential: 'skillErrorCredential',
  unknown_skill: 'skillErrorUnknown',
};

/** A refused skill write as one line: the translated message for a known code, else the server's. */
export function skillErrorText(err: unknown, t: I18nContextValue['t'], maxTokens: number): string {
  if (err instanceof ApiClientError && err.code in ERROR_KEYS) {
    return t(ERROR_KEYS[err.code as SkillErrorCode], { max: maxTokens.toLocaleString() });
  }
  return err instanceof Error && err.message ? err.message : t('error');
}
