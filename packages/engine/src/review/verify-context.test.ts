import { describe, expect, it } from 'vitest';
import type { Finding } from './types.js';
import { applyVerdicts, buildVerifyPrompt } from './verify.js';

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
