import { describe, expect, it } from 'vitest';
import type { Finding } from './types.js';
import {
  buildVerifyCriteria,
  citedRule,
  refNamesFile,
  refNamesGlob,
  withRuleCriteria,
} from './verify-criteria.js';
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
    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:B.md>>>');
    expect(prompt.user).toContain('Rule: B.md §1');
    expect(prompt.user).not.toContain('(no REVIEW_CRITERIA block shown here has this name)');
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

  it('shows no block for a rules file whose cut keeps no line, and shows the next source', () => {
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
    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:B.md>>>');
    expect(prompt.user).toContain('Rule: A.md §1 (no REVIEW_CRITERIA block shown here has this name)');
  });

  it('shows the rule a finding cites before the cap is spent on an uncited one', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [makeFinding({ ruleRef: 'nested/AGENTS.md §1' })],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [
        {
          path: 'ROOT.md',
          content: Array.from({ length: 60 }, (_, index) => `root rule ${index + 1}`).join('\n'),
        },
        { path: 'nested/AGENTS.md', content: 'Nested rule.' },
      ],
      maxCriteriaTokens: 300,
    });

    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:nested/AGENTS.md>>>');
    expect(prompt.user.indexOf('nested/AGENTS.md')).toBeLessThan(
      prompt.user.indexOf('root rule 1'),
    );
    expect(prompt.user).toContain('Rule: nested/AGENTS.md §1');
    expect(prompt.user).not.toContain('(no REVIEW_CRITERIA block shown here has this name)');
  });

  it('shows a small cited block whole before a big cited block is cut', () => {
    const prompt = buildVerifyPrompt({
      language: 'en',
      findings: [
        makeFinding({ id: 'f1', ruleRef: 'BIG.md §1' }),
        makeFinding({ id: 'f2', ruleRef: 'nested/AGENTS.md §2' }),
      ],
      files: [{ path: 'src/api.ts', patch: PATCH }],
      rulesFiles: [
        {
          path: 'BIG.md',
          content: Array.from({ length: 400 }, (_, index) => `big rule ${index + 1}`).join('\n'),
        },
        { path: 'nested/AGENTS.md', content: 'Nested rule.' },
      ],
      maxCriteriaTokens: 400,
    });

    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:nested/AGENTS.md>>>');
    expect(prompt.user).toContain('Nested rule.');
    expect(prompt.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:BIG.md>>>');
    expect(prompt.user).toContain('[verification limit: the rest of this rules block was not shown]');
    expect(prompt.user.indexOf('nested/AGENTS.md')).toBeLessThan(prompt.user.indexOf('big rule 1'));
  });
});

describe('verify criteria - buildVerifyCriteria', () => {
  it('names a rules file by its path and its file name', () => {
    const criteria = buildVerifyCriteria({
      rulesFiles: [{ path: 'docs/AGENTS.md', content: 'Hard rules.' }],
      pathInstructions: [],
      filePaths: ['src/api.ts'],
      ruleRefs: [],
      maxTokens: 4000,
    });

    expect(criteria.files).toEqual(['docs/AGENTS.md']);
    expect(citedRule('agents.md: Hard rules', criteria)).toBe('shown');
  });
});

describe('verify criteria - citedRule', () => {
  it('names a shown rules file by its whole path or by its file name', () => {
    const root = buildVerifyCriteria({
      rulesFiles: [{ path: 'AGENTS.md', content: 'Root rules.' }],
      pathInstructions: [],
      filePaths: ['src/api.ts'],
      ruleRefs: [],
      maxTokens: 4000,
    });
    const nested = buildVerifyCriteria({
      rulesFiles: [{ path: 'docs/AGENTS.md', content: 'Hard rules.' }],
      pathInstructions: [],
      filePaths: ['src/api.ts'],
      ruleRefs: [],
      maxTokens: 4000,
    });

    expect(citedRule('apps/api/AGENTS.md §2', root)).toBe('not-shown');
    expect(citedRule('agents.md: Hard rules', nested)).toBe('shown');
  });

  it('names a path instruction by its glob', () => {
    const criteria = buildVerifyCriteria({
      rulesFiles: [],
      pathInstructions: [
        { path: 'src/**', instructions: 'Log every refusal.' },
        { path: 'docs/**', instructions: 'Docs rule.' },
      ],
      filePaths: ['src/api.ts'],
      ruleRefs: [],
      maxTokens: 4000,
    });

    expect(citedRule('.mergepilot.yml docs/**', criteria)).toBe('not-shown');
    expect(citedRule('.mergepilot.yml src/**', criteria)).toBe('shown');
  });

  it('names a shown rules file by its line number, its anchor or its quotes', () => {
    const criteria = buildVerifyCriteria({
      rulesFiles: [{ path: 'CLAUDE.md', content: 'Use camelCase.' }],
      pathInstructions: [],
      filePaths: ['src/api.ts'],
      ruleRefs: [],
      maxTokens: 4000,
    });

    expect(citedRule('CLAUDE.md:13', criteria)).toBe('shown');
    expect(citedRule('CLAUDE.md#hard-rules', criteria)).toBe('shown');
    expect(citedRule('`CLAUDE.md` §5', criteria)).toBe('shown');
    expect(citedRule('"CLAUDE.md" §5', criteria)).toBe('shown');
    expect(citedRule('OTHER.md:13', criteria)).toBe('not-shown');
  });
});

describe('verify criteria - the citation helpers', () => {
  it('names a path instruction by its glob', () => {
    expect(refNamesGlob('.mergepilot.yml src/**', 'src/**')).toBe(true);
    expect(refNamesGlob('.mergepilot.yml src/**', 'docs/**')).toBe(false);
  });

  it('names a rules file in quotes, before a colon, an anchor or a trailing dot', () => {
    expect(refNamesFile('«CLAUDE.md» §5', 'CLAUDE.md')).toBe(true);
    expect(refNamesFile('“CLAUDE.md” §5', 'CLAUDE.md')).toBe(true);
    expect(refNamesFile('CLAUDE.md، القواعد', 'CLAUDE.md')).toBe(true);
    expect(refNamesFile('CLAUDE.md:13', 'CLAUDE.md')).toBe(true);
    expect(refNamesFile('CLAUDE.md#hard-rules', 'CLAUDE.md')).toBe(true);
    expect(refNamesFile('see CLAUDE.md.', 'CLAUDE.md')).toBe(true);
    expect(refNamesFile('CLAUDE.mdx §1', 'CLAUDE.md')).toBe(false);
    expect(refNamesFile('XCLAUDE.md', 'CLAUDE.md')).toBe(false);
  });

  it('names a rules file whose path holds a space', () => {
    expect(refNamesFile('"docs/project rules.md" §1', 'docs/project rules.md')).toBe(true);
  });

  it('names a dotless rules file as it is written', () => {
    expect(refNamesFile('RULES §2', 'RULES')).toBe(true);
    expect(refNamesFile('the project rules', 'RULES')).toBe(false);
  });

  it('names a rules file by its file name, not by the file name of another path', () => {
    expect(refNamesFile('apps/api/AGENTS.md §2', 'AGENTS.md')).toBe(false);
    expect(refNamesFile('agents.md: Hard rules', 'docs/AGENTS.md')).toBe(true);
  });
});

describe('verify criteria - withRuleCriteria', () => {
  it('throws when the system prompt holds no plain role line', () => {
    expect(() => withRuleCriteria('a system prompt without the role lines')).toThrow(
      'verify prompt: rule criteria lines not found',
    );
  });
});
