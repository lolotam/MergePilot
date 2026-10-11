import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'reference/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-warning-comments': ['error', { terms: ['fixme', 'hack', 'xxx'], location: 'anywhere' }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // ADR-0001: the engine never knows which shell runs it.
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/apps/**', '@mergepilot/action', '@mergepilot/cli', '@mergepilot/app'], message: 'packages/engine must not import from apps (ADR-0001).' },
          { group: ['@actions/*', '@octokit/*'], message: 'Action/GitHub-specific libraries belong outside packages/engine (ADR-0001).' },
          { group: ['**/reference/**'], message: 'reference/ is study material, never imported.' },
        ],
      }],
    },
  },
);
