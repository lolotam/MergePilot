import { describe, expect, it } from 'vitest';
import { pullRequestContextFiles, PR_CONTEXT_REASON } from './pr-context.js';
import type { ReviewedFile } from './review-context.js';

// ADR-0030: the rest of the PR is offered as `pr-change` context with its PR patch; files related
// to a reviewed file (imports, imported by, same directory) name it, the others relate to none.

const patch = (...added: string[]): string => `@@ -1,1 +1,${added.length + 1} @@\n const keep = 1;\n${added.map((l) => `+${l}`).join('\n')}`;
const file = (path: string, p: string, status = 'modified'): ReviewedFile => ({ path, status, patch: p, changes: 1 });

describe('pullRequestContextFiles', () => {
  const reviewed = [file('src/api/route.ts', patch("import { db } from '../db/client.js';"))];
  const prFiles: ReviewedFile[] = [
    reviewed[0]!,
    file('src/db/client.ts', patch('export const db = 1;')), // imported by the reviewed file
    file('src/web/page.ts', patch("import { route } from '../api/route.js';")), // imports it
    file('src/api/schema.ts', patch('export const schema = 1;')), // same directory
    file('docs/notes.md', patch('a note')), // unrelated
    file('src/old.ts', patch('gone'), 'removed'),
    file('.env', patch('SECRET=1')),
    file('src/legacy/x.ts', patch('excluded')),
  ];

  it('offers every other reviewable PR file with its patch, related ones naming the reviewed file', () => {
    const files = pullRequestContextFiles({ reviewed, prFiles, exclude: ['src/legacy/**'] });

    expect(files.map((f) => [f.path, f.forPaths, f.reason])).toEqual([
      ['src/db/client.ts', ['src/api/route.ts'], `${PR_CONTEXT_REASON}; imported by src/api/route.ts`],
      ['src/web/page.ts', ['src/api/route.ts'], `${PR_CONTEXT_REASON}; imports src/api/route.ts`],
      ['src/api/schema.ts', ['src/api/route.ts'], `${PR_CONTEXT_REASON}; same directory as src/api/route.ts`],
      ['docs/notes.md', [], PR_CONTEXT_REASON],
    ]);
    expect(files.every((f) => f.kind === 'pr-change')).toBe(true);
    expect(files[0]?.content).toBe(prFiles[1]?.patch);
  });

  it("finds a reviewed file's imports in its head content when the patch does not show them", () => {
    const quiet = [file('src/api/route.ts', patch('const changed = 2;'))];
    const files = pullRequestContextFiles({
      reviewed: quiet,
      prFiles: [quiet[0]!, file('src/db/client.ts', patch('export const db = 1;'))],
      exclude: [],
      headContent: new Map([['src/api/route.ts', "import { db } from '../db/client.js';\nconst changed = 2;"]]),
    });
    expect(files[0]?.forPaths).toEqual(['src/api/route.ts']);
  });
});
