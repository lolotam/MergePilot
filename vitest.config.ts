import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'backend',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['apps/web/**'],
          environment: 'node',
        },
      },
      'apps/web/vitest.config.ts',
    ],
  },
});
