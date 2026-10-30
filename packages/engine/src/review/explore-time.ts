/** Bound repository I/O as well as model calls, preserving the remaining answer time. */
import type { ReviewDeadline } from './call.js';
import type { RepositoryReader } from './explore.js';

export const ANSWER_TIME_RESERVED = 'time reserved for remaining batch answers';

export function reserveAnswerTime(reader: RepositoryReader, deadline: ReviewDeadline, reserveMs: number, stopped: () => void): RepositoryReader {
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    const room = deadline.remainingMs - reserveMs;
    if (room <= 0) {
      stopped();
      throw new Error(ANSWER_TIME_RESERVED);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stopped();
          reject(new Error(ANSWER_TIME_RESERVED));
        }, room);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    readFile: (path) => read(() => reader.readFile(path)),
    listDirectory: (dir) => read(() => reader.listDirectory(dir)),
    listPaths: () => read(() => reader.listPaths()),
  };
}
