import { describe, expect, it } from 'vitest';
import { claimSimilarity, claimWords, sameClaimScore } from './claim-similarity.js';

describe('claimWords', () => {
  it('keeps content words of the title and body, split at camelCase, without the Jev confidence line', () => {
    const words = claimWords({
      title: 'The replays skip applySavedLineEdit',
      body: 'It replaced 2 totals.\n\n<sub>Jev confidence: 0.55</sub>\n\n<sub>ثقة Jev: 0.55</sub>',
    });
    expect([...words].sort()).toEqual(['apply', 'edit', 'line', 'replac', 'replay', 'saved', 'skip', 'total']);
  });
});

describe('sameClaimScore', () => {
  const replay = { title: 'Stale replay overwrites the session total', body: 'A replayed response replaces the refreshed session total.' };

  it('needs both the coefficient and a few shared words', () => {
    const short = { title: 'Null check', body: 'The value may be null here.' };
    // Identical short claims share only three words: too few to decide by wording.
    expect(claimSimilarity(short, short)).toEqual({ score: 1, shared: 3 });
    expect(sameClaimScore(short, short)).toBeUndefined();
    expect(sameClaimScore(replay, { ...replay, title: 'Replay overwrites the refreshed total' })).toBeGreaterThan(0.35);
  });

  it('leaves titles of opposite polarity to the judge', () => {
    const opposite = { ...replay, title: "Stale replay doesn't overwrite the session total" };
    expect(sameClaimScore(replay, opposite)).toBeUndefined();
    expect(sameClaimScore(replay, { ...replay, title: 'Stale replay must not overwrite the session total' })).toBeUndefined();
  });

  // PayPos.systems#321 line 162 (P4/P5 of the review comparison): one issue, one title says "without".
  it('still matches a title that describes a missing step with "without"', () => {
    const omitted = {
      title: 'Historical performers are omitted from locked current-link reads',
      body:
        'FR-006 applies snapshot ∪ current link to retained performers too, but FR-004 locks only current and requested ' +
        'employees and loads new-set links alongside historical snapshots. A performer unlinked when recorded, removed, ' +
        'and linked to the changer later has a null historical snapshot and is absent from both sets. The specified reads ' +
        'therefore cannot enforce PC-10 for that user; an unlocked historical-link read would also leave a relinking race.',
    };
    const unlocked = {
      title: "Retained performers' current links read without being locked",
      body:
        'FR-006 applies the 35d rule (snapshot ∪ current link) to the union that includes the retained BEFORE identities. ' +
        'FR-004 only locks currentIds ∪ newIds with performers.lock, so the employees of removed performers are never ' +
        'locked FOR SHARE. Their current employees.user_id is then either read unlocked or not read at all. Unlocked, a ' +
        'concurrent relink can slip between the read and the commit, which is the race 35d closed with the lock.',
    };
    expect(sameClaimScore(omitted, unlocked)).toBeGreaterThan(0.35);
  });

  it('leaves claims written mostly outside Latin script to the judge', () => {
    // Two different issues that share Arabic particles and domain words: English stop words cannot filter them.
    const total = { title: 'الإجمالي القديم يستبدل إجمالي الزيارة', body: 'عند إعادة الطلب بعد حفظ غير مؤكد، هذا الرد القديم يستبدل إجمالي الزيارة الذي في اللقطة.' };
    const refusal = { title: 'المحرر يُغلق بدون عرض سبب الرفض', body: 'عند إعادة الطلب بعد حفظ غير مؤكد، هذا المحرر يُغلق قبل عرض سبب الرفض الذي في اللقطة.' };
    expect(claimSimilarity(total, refusal).shared).toBeGreaterThanOrEqual(4);
    expect(sameClaimScore(total, refusal)).toBeUndefined();
    expect(sameClaimScore(total, total)).toBeUndefined();
  });
});
