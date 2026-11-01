/** Bound repository I/O as well as model calls, within the shared exploration window. */
import type { RepositoryReader } from './explore.js';

export const EXPLORATION_TIME_SHARE = 0.25;
export const EXPLORATION_TIME_EXHAUSTED = 'exploration time share used up';

export function boundExplorationReads(reader: RepositoryReader, remainingMs: () => number, stopped: () => void): RepositoryReader {
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    const room = remainingMs();
    if (room <= 0) {
      stopped();
      throw new Error(EXPLORATION_TIME_EXHAUSTED);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stopped();
          reject(new Error(EXPLORATION_TIME_EXHAUSTED));
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
