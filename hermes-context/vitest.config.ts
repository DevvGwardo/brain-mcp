import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run test.mjs as the e2e entry point
    include: ['test.mjs'],
    // Treat .mjs files as ESM
    pool: 'vmForks',
    poolOptions: {
      vmForks: {
        singleFork: true,
      },
    },
  },
});
