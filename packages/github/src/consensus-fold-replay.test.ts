import { describe, expect, it } from 'vitest';
import { farFoldScore, foldSignalsOf } from './claim-fold.js';
import { alreadyListedReplay, distantLineReplay, linkedFilesReplay } from './consensus-fold.fixtures.js';
import { mergePanelFindings, withFoundBy } from './consensus.js';

describe('consensus fold regression replays', () => {
  it('preserves three distant anchors and alternative titles for four agreeing bots', async () => {
    const [primary, second, third, fourth] = distantLineReplay.flatMap(({ inline }) => inline);
    const primarySignals = foldSignalsOf(primary!, [primary!.path]);
    const signals = [second!, third!, fourth!].map((finding) => foldSignalsOf(finding, [primary!.path]));
    for (const other of signals) {
      expect(farFoldScore(primarySignals, other)).toBeGreaterThan(0.6);
    }

    const { kept, total } = await mergePanelFindings({ bots: distantLineReplay, minAgreement: 1 });
    expect(kept).toHaveLength(1);
    const cluster = kept[0]!;
    expect(cluster.finding).toBe(primary);
    expect(cluster.foundBy.map(({ slot }) => slot)).toEqual([1, 2, 3, 4]);
    expect(cluster.foldedPlaces).toEqual([147, 251, 290].map((line) => ({ path: primary!.path, line })));
    const { body } = withFoundBy(cluster, total, 'en');
    const places = [147, 251, 290].map((line) => primary!.path + ':' + line).join(', ');
    expect(body).toContain('Also at: ' + places + '\n\n_Found by: Reviewer 1, Reviewer 2, Reviewer 3, Reviewer 4 (4/4)_');
    expect(body).toContain('_Also raised as: "' + second!.title + '" (Reviewer 2); "' + third!.title +
      '" (Reviewer 3); "' + fourth!.title + '" (Reviewer 4)_');
  });

  it('joins linked files while keeping a second finding from the same bot separate', async () => {
    const [primary, separate, list, route] = linkedFilesReplay.flatMap(({ inline }) => inline);
    const paths = [primary!, separate!, list!, route!].map(({ path }) => path);
    const routeSignals = foldSignalsOf(route!, paths);
    expect(farFoldScore(foldSignalsOf(primary!, paths), routeSignals)).toBeGreaterThan(0.55);
    expect(farFoldScore(foldSignalsOf(list!, paths), routeSignals)!)
      .toBeGreaterThan(farFoldScore(foldSignalsOf(separate!, paths), routeSignals)! + 0.05);
    const { kept, total } = await mergePanelFindings({ bots: linkedFilesReplay, minAgreement: 1 });
    expect(kept.map(({ finding }) => finding.id)).toEqual([primary!.id, separate!.id]);
    expect(kept.map(({ foundBy }) => foundBy.map(({ slot }) => slot))).toEqual([[1, 2, 4], [2]]);
    expect(withFoundBy(kept[0]!, total, 'en').body).toContain(
      'Also at: ' + route!.path + ':171, ' + route!.path + ':161, ' + list!.path + ':53\n',
    );
    expect(withFoundBy(kept[1]!, total, 'en').body).toContain('(1/4)');
  });

  it('does not duplicate an anchor already named in the representative’s list', async () => {
    const [primary, other] = alreadyListedReplay.flatMap(({ inline }) => inline);
    const paths = [primary!.path, other!.path];
    expect(farFoldScore(foldSignalsOf(primary!, paths), foldSignalsOf(other!, paths))).toBeGreaterThan(0.6);
    const { kept, total } = await mergePanelFindings({ bots: alreadyListedReplay, minAgreement: 2 });
    expect(kept).toHaveLength(1);
    const cluster = kept[0]!;
    expect(cluster.finding).toBe(primary);
    expect(cluster.foldedPlaces).toBeUndefined();
    expect(withFoundBy(cluster, total, 'en').body.split('src/queue/retry.ts:22')).toHaveLength(2);
  });
});
