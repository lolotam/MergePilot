import type { Finding } from '@mergepilot/engine';
import { describe, expect, it } from 'vitest';
import { farFoldScore, foldedPlacesOf, foldSignalsOf, withFoldedPlaces } from './claim-fold.js';
import { foldBot, foldFinding } from './consensus-fold.fixtures.js';
import { mergePanelFindings } from './consensus.js';

const shared = 'archive payload cursor filter worker queue backup record'.split(' ');
const leftOnly = 'blue amber crimson yellow violet olive teal magenta indigo beige brown coral navy gold'.split(' ');
const rightOnly = 'birch willow spruce elm cedar pine alder maple ash oak yew palm rowan aspen'.split(' ');

// Choose the word counts directly so each pair isolates its intended threshold tier.
function pair(sharedCount: number, totalPerSide: number): [Finding, Finding] {
  const body = (unique: string[]) => [...shared.slice(0, sharedCount), ...unique.slice(0, totalPerSide - sharedCount)].join(' ');
  return [
    foldFinding('left', { path: 'a.ts', title: 'Can', body: body(leftOnly) }),
    foldFinding('right', { path: 'b.ts', line: 210, title: 'Can', body: body(rightOnly) }),
  ];
}

function score(a: Finding, b: Finding): number | undefined {
  const paths = [a.path, b.path];
  return farFoldScore(foldSignalsOf(a, paths), foldSignalsOf(b, paths));
}

describe('far fold thresholds', () => {
  it('accepts a claim below 0.40 when Also at links to within three lines', () => {
    const [a, b] = pair(4, 11);
    expect(score(a, b)).toBeUndefined();
    expect(score(a, { ...b, body: b.body + '\n\nAlso at: a.ts:13' })).toBeCloseTo(4 / 11);
    expect(score(a, { ...b, body: b.body + '\n\nAlso at: a.ts:14' })).toBeUndefined();
  });

  it('accepts a same-file claim at 200 lines apart below the cross-file threshold', () => {
    const [a, b] = pair(8, 17);
    expect(score(a, { ...b, path: a.path })).toBeCloseTo(8 / 17);
    expect(score(a, b)).toBeUndefined();
  });

  it('accepts a corroborated claim below 0.45 using evidence or a strong same-file fix', () => {
    const [a, b] = pair(8, 19);
    expect(score(a, { ...b, evidence: 'The assignment at a.ts:7 supplies the value.' })).toBeCloseTo(8 / 19);
    expect(score(a, { ...b, path: a.path })).toBeCloseTo(8 / 19);
    expect(score(a, b)).toBeUndefined();
  });

  it('accepts strongly matching cross-file wording without a location link', () => {
    const [a, b] = pair(8, 13);
    expect(score(a, b)).toBeCloseTo(8 / 13);
  });

  it.each([
    ['missing suggestion', { suggestion: undefined }],
    ['unrelated suggestion', { suggestion: 'Build wooden cabinets using stainless brackets.' }],
  ] satisfies Array<[string, Partial<Finding>]>)('rejects a strong claim with %s', (_reason, override) => {
    const [a, b] = pair(8, 13);
    expect(score(a, { ...b, ...override })).toBeUndefined();
  });

  it('rejects an otherwise matching claim dominated by non-Latin text', () => {
    const [a, b] = pair(8, 13);
    expect(score(a, { ...b, body: b.body + ' ملاحظات'.repeat(20) })).toBeUndefined();
  });

  it('rejects far folds when suggestions have opposite polarity', () => {
    const [a, b] = pair(8, 13);
    expect(score(
      { ...a, suggestion: 'Overwrite the archive manifest before retrying.' },
      { ...b, suggestion: 'Do not overwrite the archive manifest before retrying.' },
    )).toBeUndefined();
  });

  it('requires stronger suggestion agreement for titles with opposite polarity', () => {
    const [a, b] = pair(8, 13);
    const first = { ...a, suggestion: 'archive cursor azure amber violet ivory orange ochre' };
    const second = { ...b, title: 'Cannot', suggestion: 'archive cursor maple birch cedar willow pine spruce' };
    expect(score(first, { ...second, title: 'Can' })).toBeCloseTo(8 / 13);
    expect(score(first, second)).toBeUndefined();
    expect(score(first, { ...second, suggestion: 'archive cursor azure amber cedar willow pine spruce' }))
      .toBeCloseTo(16 / 27);
  });

  it.each([
    ['same-file pairs below 0.40 with different fixes', 21, 'a.ts'],
    ['unlinked cross-file pairs below 0.50', 18, 'b.ts'],
  ] as const)('keeps %s in separate clusters', async (_scenario, totalPerSide, path) => {
    const [a, b] = pair(8, totalPerSide);
    const first = { ...a, suggestion: 'archive cursor azure amber violet ivory orange ochre' };
    const second = { ...b, path, suggestion: 'archive cursor maple birch cedar willow pine spruce' };
    const { kept } = await mergePanelFindings({ bots: [foldBot(1, first), foldBot(2, second)], minAgreement: 1 });
    expect(kept.map(({ finding }) => finding.id)).toEqual(['left', 'right']);
  });
});

describe('folded places', () => {
  const extra = [{ path: 'b.ts', line: 20 }, { path: 'c.ts', line: 30 }];

  it.each([
    ['Claim.\n\n<sub>Jev confidence: 0.85</sub>', 'Claim.\n\nAlso at: b.ts:20, c.ts:30\n\n<sub>Jev confidence: 0.85</sub>'],
    ['Also at: a.ts:10\n<sub>Jev confidence: 0.85</sub>', 'Also at: a.ts:10, b.ts:20, c.ts:30\n<sub>Jev confidence: 0.85</sub>'],
    ['Also at: a.ts:10,\n  a.ts:30\n\nMore context.', 'Also at: a.ts:10,\n  a.ts:30, b.ts:20, c.ts:30\n\nMore context.'],
    ['Also at: a.ts:10,', 'Also at: a.ts:10, b.ts:20, c.ts:30'],
    ['Also at:', 'Also at: b.ts:20, c.ts:30'],
    ['Also at:\n  * a.ts:10\n<sub>Jev confidence: 0.85</sub>', 'Also at:\n  * a.ts:10\n  * b.ts:20\n  * c.ts:30\n<sub>Jev confidence: 0.85</sub>'],
    ['Also at: a.ts:10\n```ts\nconst x = 1;\n```', 'Also at: a.ts:10, b.ts:20, c.ts:30\n```ts\nconst x = 1;\n```'],
    ['Also at:\n- a.ts:10\n```ts\nconst x = 1;\n```', 'Also at:\n- a.ts:10\n- b.ts:20\n- c.ts:30\n```ts\nconst x = 1;\n```'],
  ])('appends places to the right block in %j', (body, expected) => {
    expect(withFoldedPlaces(body, extra)).toBe(expected);
  });

  it('sorts, de-duplicates and caps the new anchors', () => {
    const representative = foldFinding('primary', { path: 'a.ts', body: 'Also at: b.ts:10' });
    const many = Array.from({ length: 11 }, (_, i) => ({ path: 'c.ts', line: 50 - i * 4 }));
    const places = foldedPlacesOf(representative, foldSignalsOf(representative, ['b.ts']).listed, [
      ...many, { path: 'a.ts', line: 13 }, { path: 'b.ts', line: 13 }, { path: 'c.ts', line: 12 },
    ]);
    expect(places).toEqual(many.slice(1).reverse());
    expect(withFoldedPlaces('Claim.', many)).not.toContain('c.ts:10');
  });
});
