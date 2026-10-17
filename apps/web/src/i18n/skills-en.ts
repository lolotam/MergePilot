import type { arSkills } from './skills-ar.js';

/** Per-bot review skills (ADR-0034): the Skills card, the per-bot dropdown and the deleted-skill note. */
export const enSkills: Record<keyof typeof arSkills, string> = {
  skillsCardTitle: 'Review skills',
  skillsCardDesc:
    'A skill is a Markdown file of extra instructions for one bot. It is added on top of the core review prompt and never replaces it. Each bot picks one skill in its tab.',
  skillsEmpty: 'This workspace has no skills yet.',
  skillsColName: 'Name',
  skillsColSize: 'Size',
  skillsColUpdated: 'Last updated',
  skillsColUsedBy: 'Used by',
  skillsSize: '{size} / {max} tokens',
  skillsUnused: 'Not used',
  skillsBotSlot: 'Bot {slot}',
  skillsLimitReached: 'The workspace has the most skills allowed ({max}). Delete one to add another.',

  // Upload
  skillsUploadTitle: 'Upload a skill',
  skillsNameLabel: 'Skill name',
  skillsFileLabel: 'Markdown file (.md or .markdown)',
  skillsUploadButton: 'Upload skill',
  skillsUploading: 'Uploading...',
  skillsUploaded: 'Skill uploaded',
  skillsNameRequired: 'Give the skill a name',
  skillsNameTooLong: 'The name must be at most {max} characters',
  skillsFileRequired: 'Choose a Markdown file',
  skillsFileWrongType: 'Only .md and .markdown files are accepted',
  skillsFileTooLarge: 'This file is about {size} tokens; the limit is {max} tokens.',
  skillsFileUnreadable: 'The file could not be read.',

  // Templates
  skillsTemplatesTitle: 'Add from template',
  skillsTemplatesDesc: 'Each template creates an ordinary skill in this workspace that you can edit.',
  skillsTemplateOwnerRules: 'Owner rules',
  skillsTemplateContextOutsideDiff: 'Context outside the diff',
  skillsTemplateCrossFileConsumers: 'Cross-file consumers',
  skillsTemplateSecurity: 'Security',
  skillsTemplateAdded: 'Skill "{name}" added from the template',

  // Row actions
  skillsPreview: 'Preview',
  skillsHidePreview: 'Hide preview',
  skillsPreviewLoading: 'Loading the content...',
  skillsPreviewOf: 'Content of "{name}"',
  skillsEdit: 'Edit',
  skillsDelete: 'Delete',
  skillsActionsFor: 'Actions for "{name}"',

  // Edit
  skillsEditTitle: 'Edit "{name}"',
  skillsEditDesc: 'Rename the skill, or choose a new file to replace its content. Without a file the content stays as it is.',
  skillsReplaceFileLabel: 'New file (optional)',
  skillsSave: 'Save',
  skillsSaved: 'Skill saved',
  skillsNothingChanged: 'Nothing changed.',

  // Delete
  skillsDeleteTitle: 'Delete "{name}"?',
  skillsDeleteUnused: 'No bot uses this skill. Deleting it cannot be undone.',
  skillsDeleteUsed:
    'These bots use this skill: {bots}. After the delete they review with the core prompt only, and their next review of each open pull request will be a full one.',
  skillsDeleted: 'Skill deleted',

  // Errors
  skillErrorNameTaken: 'Another skill in this workspace already has this name',
  skillErrorLimit: 'The workspace has the most skills allowed',
  skillErrorEmpty: 'The file is empty',
  skillErrorTooLarge: 'The skill is larger than the limit ({max} tokens)',
  skillErrorNotText: 'This file is not plain text',
  skillErrorCredential: 'The name or the file contains what looks like a key or password. Remove it and try again.',
  skillErrorUnknown: 'This skill is not in this workspace',

  // The per-bot dropdown
  skillSelectLabel: 'Skill',
  skillSelectDefault: 'Default (core prompt only)',
  skillSelectHint: 'Extra instructions for this bot on top of the core prompt. Add skills in the "Review skills" card.',
  skillRemovedNote: 'The skill "{name}" was deleted; this bot now reviews with the core prompt only.',

  // Runs
  runSkillLabel: 'Skill',
};
