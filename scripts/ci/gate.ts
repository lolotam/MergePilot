import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Fail closed for missing jobs and every outcome other than success, including skipped jobs. */
export function assertSuccessfulNeeds(needs: unknown): void {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('Expected CI dependency outcomes');
  }
  const outcomes = needs as Record<string, { result?: unknown } | null>;
  const names = Object.keys(outcomes).sort();
  if (names.join(',') !== 'static,unit') throw new Error('Expected exactly static and unit outcomes');
  for (const name of names) {
    if (outcomes[name]?.result !== 'success') throw new Error(`CI dependency ${name} did not succeed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertSuccessfulNeeds(JSON.parse(process.env['CI_NEEDS'] ?? 'null'));
}
