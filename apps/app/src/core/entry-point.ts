import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `metaUrl` (its `import.meta.url`) is the script node was started with.
 * Compares file paths, not strings: on Windows `process.argv[1]` is `F:\…\main.js` while the URL
 * is `file:///F:/…/main.js`, so a suffix check never matches and the process exits silently.
 */
export function isEntryPoint(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  return Boolean(argv1) && fileURLToPath(metaUrl) === resolve(argv1 as string);
}
