import type { I18nKey } from '../../i18n/ar.js';
import contextOutsideDiff from './templates/context-outside-diff.md?raw';
import crossFileConsumers from './templates/cross-file-consumers.md?raw';
import ownerRules from './templates/owner-rules.md?raw';
import security from './templates/security.md?raw';

export interface SkillTemplate {
  id: string;
  /** The default name of the skill it creates, in the UI language. */
  nameKey: I18nKey;
  content: string;
}

/**
 * The starter skills bundled with the dashboard (ADR-0034 §11). "Add from template" copies one
 * into the workspace as an ordinary, editable skill; they are never read-only built-ins.
 */
export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  { id: 'owner-rules', nameKey: 'skillsTemplateOwnerRules', content: ownerRules },
  { id: 'context-outside-diff', nameKey: 'skillsTemplateContextOutsideDiff', content: contextOutsideDiff },
  { id: 'cross-file-consumers', nameKey: 'skillsTemplateCrossFileConsumers', content: crossFileConsumers },
  { id: 'security', nameKey: 'skillsTemplateSecurity', content: security },
];
