export {
  parsePatch,
  type HunkHeader,
  type ParsedPatch,
} from './parse-patch.js';

export {
  classifyFile,
  isContextPathAllowed,
  type FileClassification,
  type FileToClassify,
  type ClassifyFileOptions,
} from './classify-file.js';
