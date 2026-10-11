import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/app/test/integration/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    environment: 'node',
  },
});
