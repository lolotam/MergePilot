import { describe, expect, it, vi } from 'vitest';
import type { Finding, Judge, JudgeRequest } from '@mergepilot/engine';
import { foundByLabel, mergePanelFindings, withFoundBy, type PanelBotFindings } from './consensus.js';

let seq = 0;
const f = (over: Partial<Finding> = {}): Finding => ({
  id: `f-${++seq}`,
  path: 'src/a.ts',
  line: 10,
  side: 'RIGHT',
  title: 'Null dereference',
  body: 'x may be null.',
  severity: 'medium',
  category: 'correctness',
  evidence: 'x.y',
  confidence: 0.9,
  ...over,
});

const bot = (slot: number, name: string, inline: Finding[], summaryOnly: Finding[] = []): PanelBotFindings => ({
  slot,
  name,
  inline,
  summaryOnly,
});

function mockJudge(answer: (request: JudgeRequest) => Record<string, number>) {
  const decide = vi.fn(async (request: JudgeRequest) => ({
    provider: 'p',
    model: 'm',
    fallbackIndex: 0,
    answers: Object.fromEntries(
      Object.entries(answer(request)).map(([id, noul]) => [id, { type: 'noul' as const, noul }]),
    ),
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const judge = { label: 'j', entries: [], decide, report: () => ({ attempts: [], inputTokens: 0, outputTokens: 0 }) };
  return { judge: judge as unknown as Judge, decide };
}

describe('mergePanelFindings (consensus, ADR-0017)', () => {
  it('clusters by path, start line within ±3 and the same normalized title', async () => {
    const result = await mergePanelFindings({
      bots: [
        bot(1, 'Main', [f({ line: 10, title: 'Null dereference!' })]),
        bot(2, 'Owl', [f({ line: 13, title: 'null   DEREFERENCE' })]),
        bot(3, 'Fox', [f({ line: 14, title: 'Null dereference' }), f({ path: 'src/b.ts', title: 'Null dereference' })]),
      ],
      minAgreement: 1,
    });
    expect(result.total).toBe(3);
    const byPath = result.kept.map((c) => [c.finding.path, c.foundBy.map((b) => b.slot)]);
    // Line 14 is 4 away from 10 but within 3 of 13: the cluster links through bot 2.
    expect(byPath).toEqual([
      ['src/a.ts', [1, 2, 3]],
      ['src/b.ts', [3]],
    ]);
  });

  it('never merges different titles without a judge, nor findings of the same bot', async () => {
    const result = await mergePanelFindings({
      bots: [bot(1, 'Main', [f({ title: 'A thing' }), f({ title: 'A thing' })]), bot(2, 'Owl', [f({ title: 'Another thing' })])],
      minAgreement: 1,
    });
    expect(result.kept).toHaveLength(3);
  });

  it('keeps the most severe version; on a tie the lowest slot', async () => {
    const severe = await mergePanelFindings({
      bots: [bot(1, 'Main', [f({ severity: 'low', body: 'main' })]), bot(2, 'Owl', [f({ severity: 'high', body: 'owl' })])],
      minAgreement: 1,
    });
    expect(severe.kept[0]?.finding.body).toBe('owl');
    const tie = await mergePanelFindings({
      bots: [bot(3, 'Fox', [f({ body: 'fox' })]), bot(2, 'Owl', [f({ body: 'owl' })])],
      minAgreement: 1,
    });
    expect(tie.kept[0]?.finding.body).toBe('owl');
  });

  it('asks the judge once for every candidate pair and merges answers ≥ 0.8', async () => {
    const { judge, decide } = mockJudge((request) =>
      Object.fromEntries(Object.keys(request.questions).map((id) => [id, id === 'p1' ? 0.85 : 0.2])),
    );
    const result = await mergePanelFindings({
      bots: [
        bot(1, 'Main', [f({ title: 'Possible null' }), f({ path: 'src/c.ts', title: 'Race' })]),
        bot(2, 'Owl', [f({ title: 'Missing null check', line: 11 }), f({ path: 'src/c.ts', title: 'Leak' })]),
      ],
      minAgreement: 1,
      judge,
      maxUsd: 0.2,
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(Object.keys(decide.mock.calls[0]![0].questions)).toHaveLength(2);
    expect(decide.mock.calls[0]![0].maxUsd).toBe(0.2);
    expect(result.kept.map((c) => c.foundBy.length).sort()).toEqual([1, 1, 2]);
    expect(result.semantic).toEqual({ checked: 2, merged: 1 });
  });

  it('a failed judge merges nothing and says so', async () => {
    const decide = vi.fn(async () => {
      throw new Error('boom');
    });
    const judge = { label: 'j', entries: [], decide, report: () => ({ attempts: [], inputTokens: 0, outputTokens: 0 }) };
    const result = await mergePanelFindings({
      bots: [bot(1, 'Main', [f({ title: 'Possible null' })]), bot(2, 'Owl', [f({ title: 'Missing null check' })])],
      minAgreement: 1,
      judge: judge as unknown as Judge,
    });
    expect(result.kept).toHaveLength(2);
    expect(result.semantic?.unavailable).toBe('error');
  });

  // PayPos.systems#361 (2026-10-18 03:36): two bots reported this on the same line with different
  // titles; the judge's answer stayed below 0.8 and two comments were published.
  const equalRevisionA = f({
    path: 'apps/admin/src/orders/ui/session-saved-visit.tsx',
    line: 52,
    title: 'Equal-revision replays can replace authoritative snapshot figures',
    body:
      'After an uncertain save, a replacement snapshot can already contain that edit at revision 2. If the user then ' +
      'replays the retained request, its revision-2 response passes this strict comparison. A narrow response hides ' +
      'figures already confirmed by the snapshot; a full cached response replaces the session total, potentially ' +
      "discarding subsequent changes to other lines. The edited line's revision need not increase when another line " +
      'changes.\n\n<sub>Jev confidence: 0.55</sub>',
    evidence: 'if ((session.lines.find((line) => line.id === lineId)?.revision ?? 0) > answered) {',
  });
  const equalRevisionB = f({
    path: 'apps/admin/src/orders/ui/session-saved-visit.tsx',
    line: 52,
    title: 'Equal-revision replays overwrite fresher visit totals',
    body:
      'After an uncertain save, a refreshed snapshot may already include that edit plus changes to other lines. ' +
      'Replaying the retained key returns the original response with the same edited-line revision but an older ' +
      'session total. This strict comparison accepts it, and applySavedLineEdit replaces the refreshed total with the ' +
      'old response total, making the displayed total inconsistent with the displayed lines.\n\n<sub>Jev confidence: 0.60</sub>',
    evidence: 'if ((session.lines.find((line) => line.id === lineId)?.revision ?? 0) > answered) {',
  });
  // The same PR, lines 20 and 21 (03:22): two different issues that quote the same code line.
  const staleReplay = f({
    path: 'apps/admin/src/orders/ui/session-saved-visit.tsx',
    line: 20,
    title: 'Replay responses can overwrite newer snapshot figures',
    body:
      'An uncertain edit now survives a replacement snapshot. If that snapshot contains a newer line revision, ' +
      'replaying the retained key can return the original, older successful response. The onSaved callback captures ' +
      'the replacement snapshot, and saved applies the response unconditionally. Consequently, reconciliation is ' +
      'skipped and older prices, revision, and visit total replace the newer displayed values.',
    evidence: 'if (editBusy) return open.lineId;',
  });
  const hiddenRefusal = f({
    path: 'apps/admin/src/orders/ui/session-saved-visit.tsx',
    line: 21,
    title: 'Busy-kept editor closes without showing a known refusal',
    body:
      'After a same-visit snapshot replacement, the editor stays open only because `editBusy` is true, and ' +
      '`open.snapshot` still points to the old snapshot. If the replay then ends with a known refusal, the form sets ' +
      'its root error and releases the lock; `openLineId` falls through to `open.snapshot === session`, which is ' +
      'false, so the editor unmounts and the error is never visible.',
    evidence: 'if (editBusy) return open.lineId;',
  });
  const panelOf = (one: Finding[], three: Finding[]) => [
    bot(1, 'MergePilot_Bot', one),
    bot(2, 'waleed_Bot', []),
    bot(3, 'mohamed_Bot', three),
    bot(4, 'Hamza_Bot', []),
  ];

  it('merges differently titled findings with the same claim on the same line without a judge (PayPos#361)', async () => {
    const result = await mergePanelFindings({ bots: panelOf([equalRevisionA], [equalRevisionB]), minAgreement: 1 });
    expect(result.kept).toHaveLength(1);
    const cluster = result.kept[0]!;
    expect(cluster.finding.title).toBe(equalRevisionA.title);
    expect(foundByLabel(cluster, result.total, 'en')).toBe('Found by: MergePilot\\_Bot, mohamed\\_Bot (2/4)');
    expect(result.semantic).toBeUndefined();
  });

  it('counts the merged cluster toward the minimum agreement and never asks the judge for it', async () => {
    const { judge, decide } = mockJudge((request) => Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.3])));
    const result = await mergePanelFindings({ bots: panelOf([equalRevisionA], [equalRevisionB]), minAgreement: 2, judge });
    expect(result.kept.map((c) => c.foundBy.map((b) => b.slot))).toEqual([[1, 3]]);
    expect(result.below).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });

  it('keeps different issues on neighbouring lines apart, even when they quote the same code', async () => {
    const result = await mergePanelFindings({ bots: panelOf([staleReplay], [hiddenRefusal]), minAgreement: 1 });
    expect(result.kept.map((c) => c.finding.title).sort()).toEqual([hiddenRefusal.title, staleReplay.title].sort());
  });

  it('still merges by wording when the judge fails, and discloses the failed check', async () => {
    const decide = vi.fn(async (_request: JudgeRequest) => {
      throw new Error('quota');
    });
    const judge = { label: 'j', entries: [], decide, report: () => ({ attempts: [], inputTokens: 0, outputTokens: 0 }) };
    const result = await mergePanelFindings({
      bots: panelOf([equalRevisionA, staleReplay], [equalRevisionB, hiddenRefusal]),
      minAgreement: 1,
      judge: judge as unknown as Judge,
    });
    // Only the dissimilar neighbours (lines 20 and 21) are left to the judge.
    expect(decide).toHaveBeenCalledOnce();
    expect(Object.keys(decide.mock.calls[0]![0].questions)).toHaveLength(1);
    expect(result.kept.map((c) => [c.finding.line, c.foundBy.length])).toEqual([[20, 1], [21, 1], [52, 2]]);
    expect(result.semantic).toEqual({ checked: 0, merged: 0, unavailable: 'error' });
  });

  it('never puts two findings of one bot in one cluster through a third bot', async () => {
    const result = await mergePanelFindings({
      bots: [bot(1, 'Main', [f({ line: 10 }), f({ line: 13 })]), bot(2, 'Owl', [f({ line: 11 })])],
      minAgreement: 1,
    });
    expect(result.kept.map((c) => [c.finding.line, c.foundBy.map((b) => b.slot)])).toEqual([[10, [1, 2]], [13, [1]]]);
  });

  it('drops clusters below the minimum agreement but always keeps critical and high', async () => {
    const result = await mergePanelFindings({
      bots: [
        bot(1, 'Main', [f({ title: 'Agreed' }), f({ path: 'x.ts', title: 'Lonely medium' }), f({ path: 'y.ts', title: 'Lonely critical', severity: 'critical' })]),
        bot(2, 'Owl', [f({ title: 'Agreed' }), f({ path: 'z.ts', title: 'Lonely high', severity: 'high' })]),
        bot(3, 'Fox', []),
      ],
      minAgreement: 2,
    });
    expect(result.kept.map((c) => c.finding.title)).toEqual(['Lonely critical', 'Lonely high', 'Agreed']);
    expect(result.below.map((c) => c.finding.title)).toEqual(['Lonely medium']);
  });

  it('caps the kept clusters at maxFindings: most severe, then most bots; the rest is over the limit (ADR-0033)', async () => {
    const result = await mergePanelFindings({
      bots: [
        bot(1, 'Main', [f({ title: 'Agreed', line: 10 }), f({ title: 'Solo A', line: 20 }), f({ title: 'Solo B', line: 30 })]),
        bot(2, 'Owl', [f({ title: 'Agreed', line: 10 }), f({ title: 'Severe', line: 40, severity: 'high' })], [f({ title: 'Outside', path: 'z.ts' })]),
      ],
      minAgreement: 1,
      maxFindings: 3,
    });
    // Severe (high) first, then Agreed (2 bots), then the first medium by path and line.
    expect(result.kept.map((c) => c.finding.title)).toEqual(['Severe', 'Agreed', 'Solo A']);
    expect(result.overLimit.map((c) => c.finding.title)).toEqual(['Solo B', 'Outside']);
    expect(result.below).toEqual([]);
  });

  it('keeps every agreed cluster without maxFindings or when they fit it', async () => {
    const bots = [bot(1, 'Main', [f({ title: 'A' }), f({ title: 'B', line: 30 })])];
    expect((await mergePanelFindings({ bots, minAgreement: 1 })).overLimit).toEqual([]);
    const fits = await mergePanelFindings({ bots, minAgreement: 1, maxFindings: 2 });
    expect([fits.kept.length, fits.overLimit.length]).toEqual([2, 0]);
  });

  it('clusters outside-the-diff findings separately from inline ones', async () => {
    const result = await mergePanelFindings({
      bots: [bot(1, 'Main', [f()]), bot(2, 'Owl', [], [f()])],
      minAgreement: 1,
    });
    expect(result.kept.map((c) => c.kind).sort()).toEqual(['inline', 'summaryOnly']);
  });

  it('labels each cluster with the bots that found it (n/N), escaped and localized', async () => {
    const result = await mergePanelFindings({
      bots: [bot(1, 'Main', [f()]), bot(2, 'Owl *x*', [f()]), bot(3, 'Fox', [])],
      minAgreement: 1,
    });
    const cluster = result.kept[0]!;
    expect(foundByLabel(cluster, result.total, 'en')).toBe('Found by: Main, Owl \\*x\\* (2/3)');
    expect(foundByLabel(cluster, result.total, 'ar')).toBe('وجدها: Main، Owl \\*x\\* (2/3)');
    expect(withFoundBy(cluster, result.total, 'en').body).toBe('x may be null.\n\n_Found by: Main, Owl \\*x\\* (2/3)_');
  });
});
