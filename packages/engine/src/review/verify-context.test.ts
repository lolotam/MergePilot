import { describe, expect, it } from 'vitest';
import type { Finding } from './types.js';
import { applyVerdicts, buildVerifyPrompt } from './verify.js';
import { alsoAtPlaces } from './verify-prompt.js';

// ADR-0028: the verifier sees the code a finding rests on, across files, and no longer rejects a
// finding only because the code that would prove it is not shown.

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    path: 'src/api.ts',
    line: 3,
    side: 'RIGHT',
    title: 'Lock released before the write',
    body: 'The write in src/store.ts runs after the lock is released.',
    severity: 'high',
    category: 'correctness',
    evidence: 'src/store.ts:2: await db.write(row)',
    confidence: 0.85,
    ...overrides,
  };
}

const API_PATCH = '@@ -1,2 +1,3 @@\n const a = 1;\n+await unlock();\n const c = 3;';
const STORE_PATCH = '@@ -1,1 +1,2 @@\n export async function save(row) {\n+  await db.write(row)';
const OTHER_PATCH = '@@ -1,1 +1,2 @@\n const z = 0;\n+const unrelated = true;';

describe('verify prompt — code across files (ADR-0028)', () => {
  it("shows the hunks of every other file the finding's evidence or body names, and no others", () => {
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding()],
      files: [
        { path: 'src/api.ts', patch: API_PATCH },
        { path: 'src/store.ts', patch: STORE_PATCH },
        { path: 'src/other.ts', patch: OTHER_PATCH },
      ],
    });
    expect(user).toContain('<<<UNTRUSTED:HUNKS:src/api.ts>>>');
    expect(user).toContain('2 + await unlock();');
    expect(user).toContain('<<<UNTRUSTED:HUNKS:src/store.ts>>>');
    expect(user).toContain('2 +   await db.write(row)');
    expect(user).toContain('Code shown for it: src/api.ts, src/store.ts');
    expect(user).not.toContain('unrelated');
  });

  it('matches cited paths as whole paths, not as substrings of a longer path', () => {
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ evidence: 'src/store.tsx:2: await db.write(row)', body: 'See src/store.tsx.' })],
      files: [
        { path: 'src/api.ts', patch: API_PATCH },
        { path: 'src/store.ts', patch: STORE_PATCH },
        { path: 'src/store.tsx', patch: OTHER_PATCH },
      ],
    });
    expect(user).toContain('Code shown for it: src/api.ts, src/store.tsx');
    expect(user).not.toContain('<<<UNTRUSTED:HUNKS:src/store.ts>>>');
  });

  it('shows a file once even when several findings need it', () => {
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding(), finding({ id: 'f2', line: 2, evidence: 'await unlock();', body: 'b' })],
      files: [
        { path: 'src/api.ts', patch: API_PATCH },
        { path: 'src/store.ts', patch: STORE_PATCH },
      ],
    });
    expect(user.match(/<<<UNTRUSTED:HUNKS:src\/api\.ts>>>/g)).toHaveLength(1);
  });

  it('shows a named repository context file with line numbers', () => {
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'See src/lock.ts: release() never waits.', evidence: 'src/lock.ts:1: export function release() {}' })],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
      contextFiles: [{ path: 'src/lock.ts', content: 'export function release() {}', reason: 'imported by src/api.ts' }],
    });
    expect(user).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:src/lock.ts>>>');
    expect(user).toContain('  1   export function release() {}');
  });

  it('shows both the PR diff and the head file of a path sent as both, so removed lines are there (ADR-0030)', () => {
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'src/lock.ts no longer checks owner.', evidence: 'src/lock.ts:1: export function release() {}' })],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
      contextFiles: [
        { path: 'src/lock.ts', content: 'export function release() {}', reason: 'imported by src/api.ts' },
        {
          path: 'src/lock.ts',
          content: '@@ -1,2 +1,1 @@\n-if (!owner) throw new Error();\n export function release() {}',
          reason: 'changed earlier in this pull request',
          source: 'pull-request',
        },
      ],
    });
    expect(user).toContain('<<<UNTRUSTED:PR_CONTEXT:src/lock.ts>>>');
    expect(user).toContain('1 - if (!owner) throw new Error();');
    expect(user).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:src/lock.ts>>>');
  });

  it("shows a changed file's full version next to its hunks, so a cited unchanged line is there", () => {
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ evidence: 'src/api.ts:40: const timeoutMs = 0;', body: 'b' })],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
      contextFiles: [{ path: 'src/api.ts', content: `${'// filler\n'.repeat(39)}const timeoutMs = 0;`, reason: 'changed file, full version' }],
    });
    expect(user).toContain('<<<UNTRUSTED:HUNKS:src/api.ts>>>');
    expect(user).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:src/api.ts>>>');
    expect(user).toContain('40   const timeoutMs = 0;');
  });

  it('keeps the hunk near the finding line and marks what the token cap left out', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `+const filler${i} = ${i};`).join('\n');
    const patch = `@@ -1,1 +1,401 @@\n const first = 0;\n${filler}\n@@ -900,1 +1300,2 @@\n const near = 1;\n+broken();`;
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ path: 'src/big.ts', line: 1301, evidence: 'broken();', body: 'b' })],
      files: [{ path: 'src/big.ts', patch }],
      maxCodeTokens: 300,
    });
    expect(user).toContain('1301 + broken();');
    expect(user).toContain('[verification limit:');
    expect(user).not.toContain('filler399');
  });

  it("shows a window around every finding line before any finding's whole hunk", () => {
    // Finding 1 sits at the end of a 400-line hunk; finding 2 is in a hunk after it. Filling hunks
    // whole in order would spend the cap on hunk 1 (and cut it from the top) before reaching either line.
    const filler = Array.from({ length: 400 }, (_, i) => `+const filler${i} = ${i};`).join('\n');
    const patch = `@@ -1,1 +1,402 @@\n const first = 0;\n${filler}\n+bad1();\n@@ -900,1 +1300,2 @@\n const near = 1;\n+bad2();`;
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [
        finding({ path: 'src/big.ts', line: 402, evidence: 'bad1();', body: 'b' }),
        finding({ id: 'f2', path: 'src/big.ts', line: 1301, evidence: 'bad2();', body: 'b' }),
      ],
      files: [{ path: 'src/big.ts', patch }],
      maxCodeTokens: 400,
    });
    expect(user).toContain('402 + bad1();');
    expect(user).toContain('1301 + bad2();');
    expect(user).not.toContain('filler0 ');
  });

  it('shows a window around every "Also at:" place before filling whole hunks (ADR-0039)', () => {
    // The finding's own line is in src/api.ts; the same pattern sits at the end of a 400-line hunk
    // of src/big.ts. Without its own window the cap would be spent before that line.
    const filler = Array.from({ length: 400 }, (_, i) => `+const filler${i} = ${i};`).join('\n');
    const bigPatch = `@@ -1,1 +1,402 @@\n const first = 0;\n${filler}\n+unlogged();`;
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'Refusal not logged.\nAlso at: `src/big.ts:402`, src/missing.ts:9.' })],
      files: [
        { path: 'src/api.ts', patch: API_PATCH },
        { path: 'src/big.ts', patch: bigPatch },
      ],
      maxCodeTokens: 300,
    });
    expect(user).toContain('2 + await unlock();');
    expect(user).toContain('402 + unlogged();');
    expect(user).not.toContain('filler0 ');
  });

  it('keeps every "Also at:" place of one large hunk when their wide windows do not all fit', () => {
    // Three places far apart in one 402-line hunk: their wide windows together pass the cap, and
    // one window cut from the top would drop the last place.
    const filler = Array.from({ length: 400 }, (_, i) => `+const filler${i} = ${i};`).join('\n');
    const bigPatch = `@@ -1,1 +1,402 @@\n const first = 0;\n${filler}\n+unlogged();`;
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'Refusal not logged.\nAlso at: src/big.ts:50, src/big.ts:200, src/big.ts:402' })],
      files: [
        { path: 'src/api.ts', patch: API_PATCH },
        { path: 'src/big.ts', patch: bigPatch },
      ],
      maxCodeTokens: 400,
    });
    expect(user).toContain('50 + const filler48 = 48;');
    expect(user).toContain('200 + const filler198 = 198;');
    expect(user).toContain('402 + unlogged();');
  });

  it('shows an "Also at:" place that sits in a PR_CONTEXT block (ADR-0039)', () => {
    // The place is at the end of a 402-line PR diff of another file. A context block has no range
    // of its own, so the line would be cut from the top before the verifier sees it.
    const filler = Array.from({ length: 400 }, (_, i) => `+const filler${i} = ${i};`).join('\n');
    const bigPatch = `@@ -1,1 +1,402 @@\n const first = 0;\n${filler}\n+unlogged();`;
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'Refusal not logged.\nAlso at: src/big.ts:402' })],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
      contextFiles: [{ path: 'src/big.ts', source: 'pull-request', reason: 'x', content: bigPatch }],
      maxCodeTokens: 300,
    });
    expect(user).toContain('402 + unlogged();');
    expect(user).not.toContain('filler0 ');
  });

  it('shows an "Also at:" place that sits in a REPOSITORY_CONTEXT block (ADR-0039)', () => {
    // The place is the last line of a 401-line repository file shown as context.
    const filler = Array.from({ length: 400 }, (_, i) => `const filler${i} = ${i};`).join('\n');
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'Refusal not logged.\nAlso at: src/big.ts:401' })],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
      contextFiles: [{ path: 'src/big.ts', reason: 'x', content: `${filler}\nunlogged();` }],
      maxCodeTokens: 300,
    });
    expect(user).toContain('401   unlogged();');
    expect(user).not.toContain('filler0 ');
  });

  it('shows an "Also at:" place that sits in the full version of a changed file (ADR-0039)', () => {
    // The path is sent both as its hunks and as its head file: the place sits in the head file, so
    // the block keyed by the path is not the one that holds it.
    const filler = Array.from({ length: 400 }, (_, i) => `const filler${i} = ${i};`).join('\n');
    const { user } = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ body: 'Refusal not logged.\nAlso at: src/big.ts:401' })],
      files: [
        { path: 'src/api.ts', patch: API_PATCH },
        { path: 'src/big.ts', patch: '@@ -1,1 +1,2 @@\n const first = 0;\n+const second = 1;' },
      ],
      contextFiles: [{ path: 'src/big.ts', reason: 'x', content: `${filler}\nunlogged();` }],
      maxCodeTokens: 300,
    });
    expect(user).toContain('401   unlogged();');
    expect(user).not.toContain('filler0 ');
  });

  it('reads the "Also at:" places of a body', () => {
    const paths = ['src/a.ts', 'lib/b.ts', 'c.ts', 'src/my file.ts', 'src/a,b.ts'];
    expect(alsoAtPlaces('x\nAlso at: src/a.ts:3, `lib/b.ts:10-12`, not a place, c.ts:7.', paths)).toEqual([
      { path: 'src/a.ts', line: 3 },
      { path: 'lib/b.ts', line: 10 },
      { path: 'c.ts', line: 7 },
    ]);
    expect(alsoAtPlaces('Also at: `src/my file.ts:9`, src/a,b.ts:402', paths)).toEqual([
      { path: 'src/my file.ts', line: 9 },
      { path: 'src/a,b.ts', line: 402 },
    ]);
    // Only known paths count, and a known path inside a longer one is not a match.
    expect(alsoAtPlaces('Also at: other.ts:5, xsrc/a.ts:8', paths)).toEqual([]);
    expect(alsoAtPlaces('No list here: src/a.ts:3', paths)).toEqual([]);
  });

  it('reads a known path that sits inside a longer one as part of that longer place', () => {
    const paths = ['src/my file.ts', 'file.ts'];
    expect(alsoAtPlaces('Also at: `src/my file.ts:402`', paths)).toEqual([{ path: 'src/my file.ts', line: 402 }]);
    expect(alsoAtPlaces('Also at: file.ts:3, src/my file.ts:4', paths)).toEqual([
      { path: 'file.ts', line: 3 },
      { path: 'src/my file.ts', line: 4 },
    ]);
  });

  it('reads the places of a list the model wrapped over several lines', () => {
    const paths = ['src/a.ts', 'lib/b.ts', 'c.ts'];
    const body = 'Body.\nAlso at: src/a.ts:3,\n  lib/b.ts:10\n- c.ts:7\n\nlater src/a.ts:99';
    expect(alsoAtPlaces(body, paths)).toEqual([
      { path: 'src/a.ts', line: 3 },
      { path: 'lib/b.ts', line: 10 },
      { path: 'c.ts', line: 7 },
    ]);
  });

  it('shows the owner rule of a finding, so a rule about naming is not a style nit (ADR-0039)', () => {
    const withRule = buildVerifyPrompt({
      language: 'en',
      findings: [finding({ ruleRef: 'AGENTS.md §3' })],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
    });
    expect(withRule.user).toContain('Rule: AGENTS.md §3');
    const withoutRule = buildVerifyPrompt({
      language: 'en',
      findings: [finding()],
      files: [{ path: 'src/api.ts', patch: API_PATCH }],
    });
    expect(withoutRule.user).not.toContain('Rule:');
  });

  it.each(['en', 'ar'])('in %s, does not reject an owner rule as a style nit', (language) => {
    const { system } = buildVerifyPrompt({ language, findings: [finding()], files: [] });
    expect(system).toContain(
      language === 'ar'
        ? 'تفضيل أسلوبي (style nit) لا تفرضه قاعدة من قواعد المالك'
        : 'it is a style nit or preference that no owner rule requires',
    );
  });

  it.each(['en', 'ar'])('in %s, no longer rejects a finding only for depending on code not shown', (language) => {
    const { system } = buildVerifyPrompt({ language, findings: [finding()], files: [] });
    expect(system).not.toContain('Reject when it depends on code not shown in the provided hunks');
    expect(system).not.toContain('تعتمد على كود غير معروض في الأجزاء المقدمة');
    expect(system).toContain('<confirmed|plausible|rejected>');
    expect(system).toContain(language === 'ar' ? 'لا ترفض الملاحظة لمجرد أنها تعتمد على كود غير معروض' : 'Do not reject a finding only because it depends on code that is not shown');
    expect(system).toContain(language === 'ar' ? 'يناقض' : 'contradicts the claim');
  });
});

describe('applyVerdicts — plausible (ADR-0028)', () => {
  it('keeps a plausible finding with its confidence capped at 0.69', () => {
    const { kept, rejected } = applyVerdicts(
      [finding({ confidence: 0.85 }), finding({ id: 'f2', confidence: 0.6 })],
      [
        { id: 'f1', verdict: 'plausible', reason: 'needs src/store.ts' },
        { id: 'f2', verdict: 'plausible', reason: 'needs src/store.ts' },
      ],
    );
    expect(rejected).toEqual([]);
    expect(kept.map((f) => f.confidence)).toEqual([0.69, 0.6]);
  });
});
