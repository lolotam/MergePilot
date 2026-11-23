import type { Judge, JudgeRequest } from '@mergepilot/engine';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { distantLineReplay, foldBot, foldFinding } from './consensus-fold.fixtures.js';
import { capConsensusClusters, mergePanelFindings, promoteSurvivingCluster, withFoundBy } from './consensus.js';
import { deduplicateFindings } from './dedupe.js';
import { botFindingsFates } from './panel-findings-fate.js';
import { renderFindingComment } from './render.js';

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

  it('preserves non-representative Also at locations even on files without a primary anchor', async () => {
    const rep = foldFinding('rep', { path: 'src/a.ts', line: 10, severity: 'high' });
    const other = foldFinding('other', {
      path: 'src/b.ts', line: 20, severity: 'medium',
      body: first.body + '\n\nAlso at: src/c.ts:30',
    });
    const { kept } = await mergePanelFindings({ bots: [foldBot(1, rep), foldBot(2, other)], minAgreement: 1 });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.foldedPlaces).toEqual([{ path: 'src/b.ts', line: 20 }, { path: 'src/c.ts', line: 30 }]);
  });

  it('deduplicates repeated alternate titles by normalized text before capping at three', async () => {
    const bots = [
      foldBot(1, foldFinding('b1', { line: 10, severity: 'high', title: 'Primary lease title' })),
      foldBot(2, foldFinding('b2', { line: 40, title: 'Repeated Alternate!' })),
      foldBot(3, foldFinding('b3', { line: 70, title: 'repeated alternate' })),
      foldBot(4, foldFinding('b4', { line: 100, title: 'Repeated   alternate.' })),
      foldBot(5, foldFinding('b5', { line: 130, title: 'Distinct fifth title' })),
    ];
    const { kept } = await mergePanelFindings({ bots, minAgreement: 1 });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.foldedTitles).toEqual([
      { title: 'Repeated Alternate!', name: 'Reviewer 2' },
      { title: 'Distinct fifth title', name: 'Reviewer 5' },
    ]);
  });

  it('promotes a surviving distant member when the representative was already posted and tracks alreadyPosted fate', async () => {
    const posted = foldFinding('posted', { path: 'src/a.ts', line: 10, severity: 'high' });
    const fresh = foldFinding('fresh', { path: 'src/b.ts', line: 20, severity: 'medium' });
    const bots = [foldBot(1, posted), foldBot(2, fresh)];
    const { kept, below, overLimit } = await mergePanelFindings({ bots, minAgreement: 1 });
    expect(kept).toHaveLength(1);
    const promoted = promoteSurvivingCluster(kept[0]!, new Set([fresh]));
    expect(promoted?.finding).toBe(fresh);
    expect(promoted?.foldedPlaces).toBeUndefined();
    expect(promoted?.alreadyPostedSlots).toEqual([1]);
    const fates = botFindingsFates(bots, { published: [promoted!], below, overLimit, alreadyPosted: [] });
    expect(fates.map(({ slot, own, mergedIntoOther, alreadyPosted, reported }) => [slot, own, mergedIntoOther, alreadyPosted, reported]))
      .toEqual([[1, 0, 0, 1, 1], [2, 1, 0, 0, 1]]);
    expect(promoteSurvivingCluster(kept[0]!, new Set())).toBeNull();
  });

  it('prevents reposting a distant folded member already disclosed in an earlier published comment', async () => {
    const rep = foldFinding('rep', { path: 'src/a.ts', line: 10, severity: 'high' });
    const distantMember = foldFinding('distant', { path: 'src/b.ts', line: 20, severity: 'medium', title: 'Different title at distant file' });
    const { kept } = await mergePanelFindings({ bots: [foldBot(1, rep), foldBot(2, distantMember)], minAgreement: 1 });
    const publishedComment = renderFindingComment(withFoundBy(kept[0]!, 2, 'en'), { language: 'en', suggestionsAsCode: false });
    const client = {
      listReviewCommentsPage: async () => [{
        id: 1, path: rep.path, line: rep.line, body: publishedComment, user: { login: 'mergepilot[bot]' },
      }],
    } as unknown as GitHubClient;
    const deduped = await deduplicateFindings(client, {
      owner: 'org', repo: 'repo', pull_number: 1, publisherLogin: 'mergepilot[bot]',
      findings: [withFoundBy(kept[0]!, 2, 'en'), distantMember],
    });
    expect(deduped.kept).toEqual([]);
    expect(promoteSurvivingCluster(kept[0]!, new Set(deduped.kept))).toBeNull();
  });
});
