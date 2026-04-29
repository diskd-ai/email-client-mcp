import { defineConfig } from 'vitest/config';

/**
 * Vitest unit-test config. Integration tests under tests/integration/
 * are excluded from the default run; invoke with --dir tests/integration
 * when needed.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
