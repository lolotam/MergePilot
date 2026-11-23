export {
  parsePatch,
  type HunkHeader,
  type ParsedPatch,
} from './parse-patch.js';

export {
  classifyFile,
  isContextPathAllowed,
  isGeneratedArtifactPath,
  type FileClassification,
  type FileToClassify,
  type ClassifyFileOptions,
} from './classify-file.js';
