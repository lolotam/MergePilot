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
