import { ALSO_AT_BLOCK_RE, alsoAtPlaces, placesInText, type Finding } from '@mergepilot/engine';
import { escapeInline } from './bot-identity.js';
import { claimWords, hasNegation, mostlyLatin, negatedTitle, wordSetSimilarity } from './claim-similarity.js';

export const FOLD_MIN_FIX_SCORE = 0.2;
export const FOLD_POLARITY_FIX_SCORE = 0.4;
export const FOLD_LISTED_MIN_SCORE = 0.35;
export const FOLD_LISTED_MIN_SHARED = 4;
export const FOLD_SAME_FILE_MIN_SCORE = 0.45;
export const FOLD_CORROBORATED_MIN_SCORE = 0.4;
export const FOLD_CORROBORATING_FIX_SCORE = 0.4;
export const FOLD_CORROBORATING_FIX_SHARED = 4;
export const FOLD_ANYWHERE_MIN_SCORE = 0.5;
export const FOLD_MIN_SHARED_WORDS = 8;
export const FOLD_PLACE_WINDOW = 3;
export const FOLD_MAX_PLACES = 10;

type Place = Pick<Finding, 'path' | 'line'>;

interface FoldSignals {
  anchor: Place;
  claim: ReadonlySet<string>;
  fix: ReadonlySet<string> | undefined;
  fixNegated: boolean;
  listed: Place[];
  evidence: Place[];
  latin: boolean;
  negated: boolean;
}

/** Extract each finding's text and location signals once for all its pairs. */
export function foldSignalsOf(finding: Finding, knownPaths: readonly string[]): FoldSignals {
  return {
    anchor: { path: finding.path, line: finding.line },
    claim: claimWords(finding),
    fix: finding.suggestion ? claimWords({ title: '', body: finding.suggestion }) : undefined,
    fixNegated: finding.suggestion ? hasNegation(finding.suggestion) : false,
    listed: alsoAtPlaces(finding.body, knownPaths),
    evidence: placesInText(finding.evidence, knownPaths),
    latin: mostlyLatin(finding),
    negated: negatedTitle(finding),
  };
}

export function sameFoldPlace(a: Place, b: Place): boolean {
  return a.path === b.path && Math.abs(a.line - b.line) <= FOLD_PLACE_WINDOW;
}

function hasPlaceLink(a: FoldSignals, b: FoldSignals, source: 'listed' | 'evidence'): boolean {
  return a[source].some((place) => sameFoldPlace(place, b.anchor)) ||
    b[source].some((place) => sameFoldPlace(place, a.anchor));
}

/** Rank an eligible far pair by its claim score when it meets a deterministic fold tier. */
export function farFoldScore(a: FoldSignals, b: FoldSignals): number | undefined {
  if (!a.latin || !b.latin || !a.fix || !b.fix) return undefined;
  if (a.fixNegated !== b.fixNegated) return undefined;
  const fix = wordSetSimilarity(a.fix, b.fix);
  if (fix.score < FOLD_MIN_FIX_SCORE) return undefined;
  if (a.negated !== b.negated && fix.score < FOLD_POLARITY_FIX_SCORE) return undefined;

  const claim = wordSetSimilarity(a.claim, b.claim);
  if (claim.score < FOLD_LISTED_MIN_SCORE || claim.shared < FOLD_LISTED_MIN_SHARED) return undefined;
  if (hasPlaceLink(a, b, 'listed')) return claim.score;
  if (claim.shared < FOLD_MIN_SHARED_WORDS) return undefined;
  if (claim.score >= FOLD_ANYWHERE_MIN_SCORE) return claim.score;
  const samePath = a.anchor.path === b.anchor.path;
  if (samePath && claim.score >= FOLD_SAME_FILE_MIN_SCORE) return claim.score;
  const corroboratingFix = samePath && fix.score >= FOLD_CORROBORATING_FIX_SCORE &&
    fix.shared >= FOLD_CORROBORATING_FIX_SHARED;
  if (claim.score >= FOLD_CORROBORATED_MIN_SCORE && (corroboratingFix || hasPlaceLink(a, b, 'evidence'))) {
    return claim.score;
  }
  return undefined;
}

export function foldedPlacesOf(representative: Place, listed: readonly Place[], otherFindings: readonly Place[]): Place[] {
  const existing = [representative, ...listed];
  const sorted = [...otherFindings].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const places: Place[] = [];
  for (const candidate of sorted) {
    if (existing.some((place) => sameFoldPlace(place, candidate)) || places.some((place) => sameFoldPlace(place, candidate))) {
      continue;
    }
    places.push({ path: candidate.path, line: candidate.line });
    if (places.length === FOLD_MAX_PLACES) break;
  }
  return places;
}

// The multiline Also at parser would otherwise treat a directly adjacent confidence annotation
// or Markdown block (e.g. a code fence) as part of the list. Keep those blocks intact.
const TRAILING_SUB_BLOCK = /(?:^|(?:\r?\n[ \t]*)+)<sub>(?:(?!<\/sub>)[\s\S])*<\/sub>\s*$/;
const LAST_BULLET = /(?:^|\n)([ \t]*[-*+][ \t]+)[^\n]*$/;
const NON_LIST_LINE = /^[ \t]*(?:```|~~~|#|>|\|)/;
const LINE_REF = /\S+:\d+/;
const PATH_LINE_RE = /(?<![\w./:-])((?:[\w.@+-]+\/)*[\w@+-]+\.[\w-]+|[\w.@+-]+\/[\w.@+-]+):(\d+)(?!\d)/g;

/** End offset of the location lines within an `Also at:` block, stopping before prose or Markdown fences. */
function alsoAtListEnd(blockText: string): number {
  const lines = blockText.split('\n');
  let end = lines[0]!.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (NON_LIST_LINE.test(line) || !LINE_REF.test(line)) break;
    end += 1 + line.length;
  }
  return blockText.slice(0, end).trimEnd().length;
}

/** Extracts `path:line` places listed in a finding's `Also at:` section even for paths outside the panel's anchors. */
export function listedPlacesInBody(body: string): Place[] {
  const block = ALSO_AT_BLOCK_RE.exec(body);
  if (!block) return [];
  const list = block[0].slice(0, alsoAtListEnd(block[0]));
  const colon = list.indexOf(':');
  const content = colon === -1 ? '' : list.slice(colon + 1);
  const places: Place[] = [];
  for (const match of content.matchAll(PATH_LINE_RE)) {
    places.push({ path: match[1]!, line: Number(match[2]) });
  }
  return places;
}

export function withFoldedPlaces(body: string, places: readonly Place[]): string {
  if (places.length === 0) return body;
  const labels = places.slice(0, FOLD_MAX_PLACES).map(({ path, line }) => escapeInline(path) + ':' + line);
  const trailing = TRAILING_SUB_BLOCK.exec(body);
  const text = trailing ? body.slice(0, trailing.index) : body;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const block = ALSO_AT_BLOCK_RE.exec(text);
  const tail = trailing?.[0] ?? '';
  if (!block) {
    const separator = text.trimEnd() ? newline + newline : '';
    const after = tail.startsWith('<sub>') ? newline + newline + tail : tail;
    return text.trimEnd() + separator + 'Also at: ' + labels.join(', ') + after;
  }

  const list = block[0].slice(0, alsoAtListEnd(block[0]));
  const end = block.index + list.length;
  const bullet = LAST_BULLET.exec(list)?.[1];
  const afterColon = list.slice(list.indexOf(':') + 1).trim();
  const separator = list.endsWith(',') || !afterColon ? ' ' : ', ';
  const addition = bullet ? newline + bullet + labels.join(newline + bullet) : separator + labels.join(', ');
  return text.slice(0, end) + addition + text.slice(end) + tail;
}
