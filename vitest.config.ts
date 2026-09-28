import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 45_000,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/fixtures/**'],
  },
});
