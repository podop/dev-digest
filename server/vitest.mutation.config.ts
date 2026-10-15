// Vitest config for Stryker (`pnpm mutate`): only the unit tests of the mutated module,
// so every mutant is judged by its own tests and no Testcontainers suite starts.
// Not mergeConfig(base, …): it concatenates `include` arrays instead of replacing them.
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  resolve: base.resolve,
  test: {
    globals: true,
    environment: 'node',
    include: ['test/eval-case-input.test.ts'],
  },
});
