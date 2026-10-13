import { describe, expect, it } from 'vitest';
import {
  buildBotCommentMarker,
  buildMarker,
  commentBotSlot,
  markerBotSlot,
  parseMarker,
} from './marker.js';

describe('review marker with a bot slot (ADR-0017)', () => {
  it('slot 1 never writes bot=', () => {
    expect(buildMarker({ headSha: 'abc', configHash: 'cfg', bot: 1 })).toBe(
      '<!-- mergepilot:review head=abc config=cfg -->',
    );
  });

  it('builds and parses a marker for an extra bot', () => {
    const marker = buildMarker({ headSha: 'abc', configHash: 'cfg', bot: 3 });
    expect(marker).toBe('<!-- mergepilot:review head=abc config=cfg bot=3 -->');
    expect(parseMarker(marker)).toEqual({ headSha: 'abc', configHash: 'cfg', bot: 3 });
  });

  it('round-trips partial combined with bot', () => {
    const marker = buildMarker({ headSha: 'abc', configHash: 'cfg', status: 'partial', bot: 2 });
    expect(marker).toBe('<!-- mergepilot:review head=abc config=cfg status=partial bot=2 -->');
    expect(parseMarker(marker)).toEqual({ headSha: 'abc', configHash: 'cfg', status: 'partial', bot: 2 });
  });

  it('an old marker (no bot=) parses as slot 1', () => {
    const old = parseMarker('<!-- mergepilot:review head=abc config=cfg -->');
    expect(old).toEqual({ headSha: 'abc', configHash: 'cfg' });
    expect(markerBotSlot(old!)).toBe(1);
    const oldPartial = parseMarker('<!-- mergepilot:review head=abc config=cfg status=partial -->');
    expect(markerBotSlot(oldPartial!)).toBe(1);
    expect(markerBotSlot(parseMarker('<!-- mergepilot:review head=a config=c bot=4 -->')!)).toBe(4);
  });

  it('an explicit bot=1 reads as slot 1 without a bot field', () => {
    expect(parseMarker('<!-- mergepilot:review head=abc config=cfg bot=1 -->')).toEqual({
      headSha: 'abc',
      configHash: 'cfg',
    });
  });
});

describe('inline comment bot marker', () => {
  it('is empty for slot 1 and hidden for extra bots', () => {
    expect(buildBotCommentMarker(1)).toBe('');
    expect(buildBotCommentMarker(5)).toBe('<!-- mergepilot:bot=5 -->');
  });

  it('a comment without a bot marker belongs to slot 1', () => {
    expect(commentBotSlot('### Title\n\nbody\n\n<!-- mp:f=abc -->')).toBe(1);
    expect(commentBotSlot(null)).toBe(1);
  });

  it('reads only a marker at the end, so one quoted inside the body cannot claim another bot', () => {
    expect(commentBotSlot('body <!-- mergepilot:bot=2 -->\n\n<!-- mp:f=abc -->\n\n<!-- mergepilot:bot=3 -->')).toBe(3);
    expect(commentBotSlot('<!-- mp:f=abc -->\n\n<!-- mergepilot:bot=4 -->\n')).toBe(4);
    expect(commentBotSlot('body <!-- mergepilot:bot=2 -->\n\n<!-- mp:f=abc -->')).toBe(1);
  });
});
