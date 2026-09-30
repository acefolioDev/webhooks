import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Legacy decorators with emitted metadata, as in the nestjs/nest monorepo, so
  // parameter decorators and DI type lookup work in the specs. Class fields declared
  // without an initializer are types only, as under `tsc` with `useDefineForClassFields: false`.
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
    assumptions: { setPublicClassFields: true },
    typescript: { removeClassFieldsWithoutInitializer: true },
  },
  test: {
    globalSetup: ['tests/support/generate-prisma-client.ts', 'tests/support/global-setup.ts'],
    globals: true,
    setupFiles: ['reflect-metadata'],
    // tests/postgres/ is PostgresWebhookStore's own project (@nestjs/webhooks/postgres): its contracts through every
    // executor on PostgreSQL (SQL_TEST_PG_URL, else a throwaway cluster from local binaries, else skipped with the
    // reason) and on PGlite, its migrations and command, and the module on it. `--project webhooks:postgres-store`
    // runs it alone.
    projects: [
      {
        extends: true,
        test: {
          name: 'webhooks',
          include: ['tests/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, 'tests/postgres/**'],
        },
      },
      {
        extends: true,
        test: { name: 'webhooks:postgres-store', include: ['tests/postgres/**/*.spec.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
      },
    ],
  },
});
