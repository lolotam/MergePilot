import { describe, expect, it } from 'vitest';
import type { Finding } from './types.js';
import { buildVerifyCriteria, citedRule, withRuleCriteria } from './verify-criteria.js';
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

  it('leaves a rules block that keeps no line at the token cap unshown', () => {
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

    expect(prompt.user).not.toContain('<<<REVIEW_CRITERIA:RULES_FILE:A.md>>>');
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

  it('keeps the system prompt plain when no finding cites a rule', () => {
    const input = {
      language: 'en' as const,
      findings: [makeFinding()],
      files: [{ path: 'src/api.ts', patch: PATCH }],
    };
    const withRules = buildVerifyPrompt({ ...input, rulesFiles: [RULES_FILE] });
    const withoutRules = buildVerifyPrompt(input);

    expect(withRules.system).toBe(withoutRules.system);
    expect(withRules.user).toBe(withoutRules.user);
    expect(withoutRules.system).toContain('- it is a style nit or preference;');
    expect(withoutRules.system).not.toContain('REVIEW_CRITERIA');
  });

  it('exempts a cited rule in the system prompt only when a rule is shown', () => {
    const input = {
      language: 'en' as const,
      findings: [makeFinding({ ruleRef: 'CLAUDE.md §5' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
    };
    const withRuleBlock = buildVerifyPrompt({ ...input, rulesFiles: [RULES_FILE] });
    const withoutRuleBlock = buildVerifyPrompt(input);

    expect(withRuleBlock.system).toContain(
      'nor, for a finding with a Rule line, in a REVIEW_CRITERIA block shown',
    );
    expect(withRuleBlock.system).toContain("Blocks marked REVIEW_CRITERIA are the repository owner's rules");
    expect(withRuleBlock.system).not.toBe(withoutRuleBlock.system);
  });

  it('exempts a cited rule in the Arabic system prompt too', () => {
    const prompt = buildVerifyPrompt({
      language: 'ar',
      findings: [makeFinding({ ruleRef: 'CLAUDE.md §5' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [RULES_FILE],
    });

    expect(prompt.system).toContain('ولا في كتلة REVIEW_CRITERIA معروضة');
  });

  it('shows no rule exception when no rule block is shown', () => {
    const input = {
      language: 'en' as const,
      findings: [makeFinding({ ruleRef: 'CLAUDE.md §5' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
    };
    const withoutRuleRef = buildVerifyPrompt({ ...input, findings: [makeFinding()] });

    expect(buildVerifyPrompt(input).system).toBe(withoutRuleRef.system);
  });

  it('cuts a rules block at the cap and says the cited rule may not be shown', () => {
    // 41 rule lines: the whole block is a few tokens over the cap, so it is cut.
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: 'A.md §9' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [
        { path: 'A.md', content: Array.from({ length: 41 }, (_, index) => `rule line number ${index + 1}`).join('\n') },
      ],
      maxCriteriaTokens: 250,
    });

    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:A.md>>>');
    expect(prompt.user).toContain('[verification limit: the rest of this rules block was not shown]');
    expect(prompt.user).toContain(
      'Rule: A.md §9 (the cited block was cut at the verification limit: the rule may not be shown)',
    );
  });

  it('shows no block for a rules file whose cut keeps no line', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: 'A.md §1' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [
        { path: 'A.md', content: 'a '.repeat(3000) },
        { path: 'B.md', content: 'b' },
      ],
      maxCriteriaTokens: 500,
    });

    expect(prompt.user).not.toContain('<<<REVIEW_CRITERIA:RULES_FILE:A.md>>>');
    expect(prompt.user).toContain('Rule: A.md §1 (no REVIEW_CRITERIA block shown here has this name)');
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

    expect(criteria.files).toEqual(['docs/AGENTS.md']);
    expect(citedRule('agents.md: Hard rules', criteria)).toBe('shown');
  });
});

describe('verify criteria - citedRule', () => {
  it('names a shown rules file by its whole path or by its file name', () => {
    const root = buildVerifyCriteria([{ path: 'AGENTS.md', content: 'Root rules.' }], [], ['src/api.ts'], 4000);
    const nested = buildVerifyCriteria(
      [{ path: 'docs/AGENTS.md', content: 'Hard rules.' }],
      [],
      ['src/api.ts'],
      4000,
    );

    expect(citedRule('apps/api/AGENTS.md §2', root)).toBe('not-shown');
    expect(citedRule('agents.md: Hard rules', nested)).toBe('shown');
  });

  it('names a path instruction by its glob', () => {
    const criteria = buildVerifyCriteria(
      [],
      [
        { path: 'src/**', instructions: 'Log every refusal.' },
        { path: 'docs/**', instructions: 'Docs rule.' },
      ],
      ['src/api.ts'],
      4000,
    );

    expect(citedRule('.mergepilot.yml docs/**', criteria)).toBe('not-shown');
    expect(citedRule('.mergepilot.yml src/**', criteria)).toBe('shown');
  });
});

describe('verify criteria - withRuleCriteria', () => {
  it('throws when the system prompt holds no plain role line', () => {
    expect(() => withRuleCriteria('a system prompt without the role lines')).toThrow(
      'verify prompt: rule criteria lines not found',
    );
  });
});
