import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// Files that measure git against a fixed time bound: they run after the parallel pool, one at a time.
const SERIAL = ['tests/control/repo-query-caches.test.ts'];

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
      react: fileURLToPath(new URL('./apps/web/node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./apps/web/node_modules/react-dom', import.meta.url)),
      '@anthropic-ai/claude-agent-sdk': fileURLToPath(
        new URL('./packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk', import.meta.url),
      ),
    },
  },
  test: {
    setupFiles: ['tests/web/i18n-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    projects: [
      {
        extends: true,
        test: {
          name: 'pool',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...SERIAL],
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
