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
          // PGlite tests run every migration in their setup; under full-suite load that can pass 10s.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      'apps/web/vitest.config.ts',
    ],
  },
});
