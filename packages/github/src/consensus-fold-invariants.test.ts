import type { Judge, JudgeRequest } from '@mergepilot/engine';
import { describe, expect, it, vi } from 'vitest';
import { distantLineReplay, foldBot, foldFinding } from './consensus-fold.fixtures.js';
import { capConsensusClusters, mergePanelFindings, withFoundBy } from './consensus.js';
import { botFindingsFates } from './panel-findings-fate.js';

describe('far folds in the existing consensus pipeline', () => {
  const first = foldFinding('first');
  const distant = foldFinding('distant', { line: 100 });

  it('assigns the competing bot slot to the highest scoring claim', async () => {
    const weaker = foldFinding('weaker', { line: 40, body: first.body + ' Other pipeline steps may buffer data.' });
    const { kept } = await mergePanelFindings({
      bots: [foldBot(1, weaker, first), foldBot(2, distant)], minAgreement: 1,
    });
    expect(kept.map(({ finding, foundBy }) => [finding.id, foundBy.map(({ slot }) => slot)]))
      .toEqual([['first', [1, 2]], ['weaker', [1]]]);
  });

  it('keeps inline and summary-only findings in separate clusters', async () => {
    const { kept } = await mergePanelFindings({
      bots: [foldBot(1, first), { ...foldBot(2), summaryOnly: [distant] }], minAgreement: 1,
    });
    expect(kept.map(({ kind, foundBy }) => [kind, foundBy.length])).toEqual([['inline', 1], ['summaryOnly', 1]]);
  });

  it('folds summary-only findings of different bots', async () => {
    const { kept } = await mergePanelFindings({
      bots: [
        { ...foldBot(1), summaryOnly: [first] },
        { ...foldBot(2), summaryOnly: [distant] },
      ],
      minAgreement: 2,
    });
    expect(kept.map(({ kind, foundBy, foldedPlaces }) => [kind, foundBy.length, foldedPlaces]))
      .toEqual([['summaryOnly', 2, [{ path: distant.path, line: distant.line }]]]);
  });

  it('neither incorporates nor revives far verifier rejections', async () => {
    const rejected = (slot: number, finding: typeof first) => ({
      ...foldBot(slot), rejected: [{ finding, kind: 'inline' as const, reason: 'Insufficient evidence' }],
    });
    const withKept = await mergePanelFindings({ bots: [foldBot(1, first), rejected(2, distant)], minAgreement: 1 });
    expect(withKept.kept).toMatchObject([{ finding: first, foundBy: [{ slot: 1 }] }]);
    expect(withKept.kept[0]!.rejectedBy).toBeUndefined();
    const onlyRejected = await mergePanelFindings({ bots: [rejected(1, first), rejected(2, distant)], minAgreement: 1 });
    expect(onlyRejected).toMatchObject({ kept: [], below: [], overLimit: [] });
  });

  it('reserves a bot slot for a nearby title match before scoring distant claims', async () => {
    const near = foldFinding('near', { line: 12, body: 'The root issue also affects maintenance runs.' });
    const { kept } = await mergePanelFindings({
      bots: [foldBot(1, first), foldBot(2, distant, near)], minAgreement: 1,
    });
    expect(kept.map(({ finding, foundBy }) => [finding.id, foundBy.length])).toEqual([['first', 2], ['distant', 1]]);
    expect(kept[0]!.foldedPlaces).toBeUndefined();
  });

  it('asks the judge about the undecided nearby pair while omitting far candidates', async () => {
    const near = foldFinding('near', { line: 12, title: 'Missing buffer check', body: 'Truncation damages output.' });
    const far = foldFinding('far', { line: 500, title: 'Remote anchor', body: 'Unrelated content.' });
    const decide = vi.fn(async (_request: JudgeRequest) => ({
      provider: 'p', model: 'm', fallbackIndex: 0, answers: {},
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = { decide } as unknown as Judge;
    await mergePanelFindings({ bots: [foldBot(1, first), foldBot(2, near, far)], minAgreement: 1, judge });
    expect(decide).toHaveBeenCalledOnce();
    const { questions, state } = decide.mock.calls[0]![0];
    expect(Object.values(questions)).toHaveLength(1);
    expect(JSON.stringify(state)).toContain(near.title);
    expect(JSON.stringify(state)).not.toContain(far.title);
  });

  it('preserves places through agreement and cap outcomes', async () => {
    const bots = [foldBot(1, first), foldBot(2, distant)];
    const { kept } = await mergePanelFindings({ bots, minAgreement: 1 });
    const { below } = await mergePanelFindings({ bots, minAgreement: 3 });
    const { overLimit } = await mergePanelFindings({ bots, minAgreement: 1, maxFindings: 0 });
    expect(kept[0]!.foldedPlaces).toEqual([{ path: distant.path, line: distant.line }]);
    expect(below[0]!.foldedPlaces).toEqual(kept[0]!.foldedPlaces);
    expect(overLimit[0]!.foldedPlaces).toEqual(kept[0]!.foldedPlaces);
    expect(capConsensusClusters(kept, 0).overLimit[0]).toBe(kept[0]);
  });

  it('accounts for the representative and every folded copy in the bot fates', async () => {
    const { kept, below, overLimit } = await mergePanelFindings({ bots: distantLineReplay, minAgreement: 1 });
    const fates = botFindingsFates(distantLineReplay, { published: kept, below, overLimit, alreadyPosted: [] });
    expect(fates.map(({ slot, own, mergedIntoOther, reported }) => [slot, own, mergedIntoOther, reported]))
      .toEqual([[1, 1, 0, 1], [2, 0, 1, 1], [3, 0, 1, 1], [4, 0, 1, 1]]);
  });

  it('renders escaped alternative titles and names in the review language', () => {
    const body = withFoundBy({
      finding: first, kind: 'inline', foundBy: [{ slot: 1, name: 'Main' }, { slot: 2, name: '<Bot>' }],
      foldedTitles: [{ title: '*Worker*', name: '<Bot>' }],
    }, 2, 'ar').body;
    expect(body).toContain('_وردت أيضاً بصياغة: "\\*Worker\\*" (&lt;Bot&gt;)_');
  });
});
