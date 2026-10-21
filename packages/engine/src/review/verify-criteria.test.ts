import { describe, expect, it } from 'vitest';
import type { Finding } from './types.js';
import { buildVerifyCriteria, namesShownRule } from './verify-criteria.js';
import { buildVerifyPrompt } from './verify-prompt.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    path: 'src/api.ts',
    line: 2,
    side: 'RIGHT',
    title: 'Exported name is not camelCase',
    body: 'The exported name breaks the naming rule.',
    severity: 'medium',
    category: 'project-rule',
    evidence: 'export const user_name = 1;',
    confidence: 0.8,
    ...overrides,
  };
}

/** One hunk: the added line is line 2 of the new file. */
const PATCH = ['@@ -1,1 +1,2 @@', ' const a = 1;', '+export const user_name = 1;'].join('\n');

const RULES_FILE = {
  path: 'CLAUDE.md',
  content: '## 5. Naming\nUse camelCase for every exported name.',
};

describe('verify criteria - the owner rules the verifier is shown', () => {
  it('shows the rule a finding cites, so a broken rule is not a style nit', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: 'CLAUDE.md §5' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [RULES_FILE],
    });

    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:CLAUDE.md>>>');
    expect(prompt.user).toContain('Use camelCase for every exported name.');
    expect(prompt.user).toContain('Rule: CLAUDE.md §5');
    expect(prompt.user).not.toContain('(no REVIEW_CRITERIA block shown here has this name)');
    expect(prompt.system).toContain('unless its Rule line names a rule shown in a REVIEW_CRITERIA block');
    expect(prompt.system).toContain("Blocks marked REVIEW_CRITERIA are the repository owner's rules");
  });

  it('marks a ruleRef that names no shown rule', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: 'STYLEGUIDE.md §2' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [RULES_FILE],
    });

    expect(prompt.user).toContain('Rule: STYLEGUIDE.md §2 (no REVIEW_CRITERIA block shown here has this name)');
    expect(prompt.system).toContain('- it is a style nit or preference, unless');
  });

  it('shows no rules when no finding cites one', () => {
    const input = {
      language: 'en' as const,
      findings: [makeFinding()],
      files: [{ path: 'src/api.ts', patch: PATCH }],
    };
    const withRules = buildVerifyPrompt({ ...input, rulesFiles: [RULES_FILE] });
    const withoutRules = buildVerifyPrompt(input);

    expect(withRules.user).not.toContain('REVIEW_CRITERIA');
    expect(withRules.user).toBe(withoutRules.user);
  });

  it('cuts the rules at the token cap and leaves the rest unshown', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: 'B.md §1' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [
        { path: 'A.md', content: 'a '.repeat(3000) },
        { path: 'B.md', content: 'b' },
      ],
      maxCriteriaTokens: 500,
    });

    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:A.md>>>');
    expect(prompt.user).toContain('[verification limit: the rest of this rules block was not shown]');
    expect(prompt.user).not.toContain('<<<REVIEW_CRITERIA:RULES_FILE:B.md>>>');
    expect(prompt.user).toContain('Rule: B.md §1 (no REVIEW_CRITERIA block shown here has this name)');
  });

  it('shows the path instructions that match a changed file', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: '.mergepilot.yml src/**' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      pathInstructions: [
        { path: 'src/**', instructions: 'Log every refusal.' },
        { path: 'docs/**', instructions: 'Docs rule.' },
      ],
    });

    expect(prompt.user).toContain('PATH_INSTRUCTIONS:src/**');
    expect(prompt.user).toContain('Log every refusal.');
    expect(prompt.user).not.toContain('Docs rule.');
    expect(prompt.user).toContain('Rule: .mergepilot.yml src/**');
    expect(prompt.user).not.toContain('(no REVIEW_CRITERIA block shown here has this name)');
  });

  it('keeps the rule exception in the Arabic role', () => {
    const prompt = buildVerifyPrompt({
      language: 'ar',
      findings: [makeFinding({ ruleRef: 'CLAUDE.md §5' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [RULES_FILE],
    });

    expect(prompt.system).toContain('إلا إذا كان سطر Rule فيها يذكر قاعدة معروضة');
  });
});

describe('verify criteria - buildVerifyCriteria', () => {
  it('names a rules file by its path and its file name', () => {
    const criteria = buildVerifyCriteria(
      [{ path: 'docs/AGENTS.md', content: 'Hard rules.' }],
      [],
      ['src/api.ts'],
      4000,
    );

    expect(criteria.names).toEqual(['docs/AGENTS.md', 'AGENTS.md']);
    expect(namesShownRule('agents.md: Hard rules', criteria.names)).toBe(true);
  });
});
