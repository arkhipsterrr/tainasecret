import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    // integration tests hit the live dummy account; run them explicitly
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    testTimeout: 20000,
  },
});
