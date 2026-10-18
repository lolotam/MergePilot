import type { Finding } from '@mergepilot/engine';

/**
 * Whether two findings make the same claim, from their words alone (ADR-0017 amendment
 * «deterministic same-issue rule»). The consensus merge uses it for findings already on the same
 * path within the line window, so it does not depend on the Jev judge being available.
 *
 * The claim is the title and body. The evidence is left out: two different issues on one line
 * often quote the same code. The Jev confidence line added to an annotated body is left out too.
 * Words are lowercased, camelCase is split, stop words and numbers are dropped, and a few
 * English suffixes are cut so "replays" and "replaying" count as one word.
 */

/** Dice coefficient of the two claims' word sets at or above which they are the same claim. */
export const CLAIM_SIMILARITY_THRESHOLD = 0.35;
/** Fewest shared words: on a handful of words the coefficient is noise. */
export const CLAIM_MIN_SHARED_WORDS = 4;

const STOP_WORDS = new Set(
  (
    'the and but for nor than that this these those with from into are was were been being its can could may ' +
    'might must should would will not also only just very more most less least other another any each every some ' +
    'all both either neither one two after before when while where which who whom whose what why how there here ' +
    'their them they she you your our out over under again further once same now still yet already even ever ' +
    'about above below between through during without within down off does did has have had having because until ' +
    'per via whether instead rather then such'
  ).split(' '),
);
const SUFFIXES = ['ing', 'ed', 'es', 's', 'e'];
const MIN_STEM = 4;
/** `<sub>Jev confidence: 0.55</sub>` / `<sub>ثقة Jev: 0.55</sub>` (`confidenceLine` in the engine). */
const SUB_LINE = /<sub>[\s\S]*?<\/sub>/g;

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) return word.slice(0, -suffix.length);
  }
  return word;
}

/** The distinct content words of a finding's title and body. */
export function claimWords(finding: Pick<Finding, 'title' | 'body'>): Set<string> {
  const text = `${finding.title}\n${finding.body.replace(SUB_LINE, ' ')}`;
  const words = text
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\p{N}+$/u.test(w))
    .map(stem);
  return new Set(words);
}

/** Dice coefficient of the two findings' claim words, with how many words they share. */
export function claimSimilarity(
  a: Pick<Finding, 'title' | 'body'>,
  b: Pick<Finding, 'title' | 'body'>,
): { score: number; shared: number } {
  const wa = claimWords(a);
  const wb = claimWords(b);
  if (wa.size === 0 || wb.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared++;
  return { score: (2 * shared) / (wa.size + wb.size), shared };
}

export function sameClaim(a: Pick<Finding, 'title' | 'body'>, b: Pick<Finding, 'title' | 'body'>): boolean {
  const { score, shared } = claimSimilarity(a, b);
  return shared >= CLAIM_MIN_SHARED_WORDS && score >= CLAIM_SIMILARITY_THRESHOLD;
}
