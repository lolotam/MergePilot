import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['deploy/**/*.test.ts'],
    environment: 'node',
  },
});
