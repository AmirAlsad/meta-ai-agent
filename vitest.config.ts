import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 5000,
    hookTimeout: 5000,
    clearMocks: true,
    restoreMocks: true
  }
});
