import { expect, it, vi } from 'vitest';
import { ReviewDeadline } from './call.js';
import { reserveAnswerTime, ANSWER_TIME_RESERVED } from './explore-time.js';

it('stops waiting for repository I/O before consuming the answer reserve', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    const stopped = vi.fn();
    const reader = reserveAnswerTime({ readFile: () => new Promise(() => {}), listDirectory: async () => null, listPaths: async () => null }, new ReviewDeadline(1000), 600, stopped);
    const rejected = expect(reader.readFile('src/a.ts')).rejects.toThrow(ANSWER_TIME_RESERVED);
    await vi.advanceTimersByTimeAsync(400);
    await rejected;
    expect(stopped).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});
