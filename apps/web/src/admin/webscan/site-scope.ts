import type {
  WebScanParameterRule,
  WebScanPathRule,
  WebScanScope,
  WebScanScopeInput,
} from '@mergepilot/app/contract';
import { nextRowId, type ParameterRuleDraft, type PathDraft, type PathRuleDraft } from './ScopeFields.js';

/**
 * The scope of a site, as the form holds it.
 *
 * The scope is a list of rules, and the form edits them as text: an empty row
 * is dropped and a path is trimmed, so the stored scope never holds a blank
 * rule. Every row carries an id of its own, so a row that is removed from the
 * middle of a list does not move the rows after it.
 */
export interface ScopeDraft {
  crawlPaths: PathRuleDraft[];
  blockedPaths: PathRuleDraft[];
  parameterizedPaths: ParameterRuleDraft[];
  activePaths: ParameterRuleDraft[];
  extraFilePaths: PathDraft[];
}

/** The scope of a new site: empty, as the ADR requires. */
export function emptyScopeDraft(): ScopeDraft {
  return {
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  };
}

export function toScopeDraft(scope: WebScanScope): ScopeDraft {
  return {
    crawlPaths: scope.crawlPaths.map((rule) => ({ id: nextRowId(), path: rule.path, kind: rule.kind })),
    blockedPaths: scope.blockedPaths.map((rule) => ({ id: nextRowId(), path: rule.path, kind: rule.kind })),
    parameterizedPaths: scope.parameterizedPaths.map((rule) => ({
      id: nextRowId(),
      path: rule.path,
      parameters: rule.parameters.join(' '),
    })),
    activePaths: scope.activePaths.map((rule) => ({
      id: nextRowId(),
      path: rule.path,
      parameters: rule.parameters.join(' '),
    })),
    extraFilePaths: scope.extraFilePaths.map((path) => ({ id: nextRowId(), path })),
  };
}

function toPathRules(rules: PathRuleDraft[]): WebScanPathRule[] {
  return rules
    .map((rule) => ({ path: rule.path.trim(), kind: rule.kind }))
    .filter((rule) => rule.path !== '');
}

function toParameterRules(rules: ParameterRuleDraft[]): WebScanParameterRule[] {
  return rules
    .map((rule) => ({
      path: rule.path.trim(),
      parameters: rule.parameters.split(/\s+/).filter((name) => name !== ''),
    }))
    .filter((rule) => rule.path !== '');
}

/** The scope as the API takes it. */
export function toScopeInput(draft: ScopeDraft): WebScanScopeInput {
  return {
    crawlPaths: toPathRules(draft.crawlPaths),
    blockedPaths: toPathRules(draft.blockedPaths),
    parameterizedPaths: toParameterRules(draft.parameterizedPaths),
    activePaths: toParameterRules(draft.activePaths),
    extraFilePaths: draft.extraFilePaths.map((row) => row.path.trim()).filter((path) => path !== ''),
  };
}

/** Whether two scopes hold the same rules. */
export function sameScope(a: WebScanScopeInput, b: WebScanScopeInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether every path of the draft is a same-host relative path. The server
 * checks the same shape, but the dashboard refuses it earlier with a clear
 * message.
 */
export function scopePathsValid(draft: ScopeDraft): boolean {
  const paths = [
    ...draft.crawlPaths.map((rule) => rule.path),
    ...draft.blockedPaths.map((rule) => rule.path),
    ...draft.parameterizedPaths.map((rule) => rule.path),
    ...draft.activePaths.map((rule) => rule.path),
    ...draft.extraFilePaths.map((row) => row.path),
  ];
  return paths.every((path) => path.trim() === '' || path.trim().startsWith('/'));
}
