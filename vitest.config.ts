import { configDefaults, defineConfig } from 'vitest/config';

/** The PostgreSQL projects' global setup: their Prisma client, and the sweep of stale `whk_` databases. */
const postgresSetup = ['tests/support/generate-prisma-client.ts', 'tests/support/global-setup.ts'];

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
    globals: true,
    setupFiles: ['reflect-metadata'],
    // tests/postgres/ is PostgresWebhookStore's own project (@nestjs/webhooks/postgres): its contracts through every
    // executor on PostgreSQL (SQL_TEST_PG_URL, else a throwaway cluster from local binaries, else skipped with the
    // reason) and on PGlite, its migrations and command, and the module on it. `--project webhooks:postgres-store`
    // runs it alone. tests/mysql/ is MySqlWebhookStore's (@nestjs/webhooks/mysql), on the MySQL of SQL_TEST_MYSQL_URL,
    // else skipped with the reason: `--project webhooks:mysql-store`. Each project's global setup generates only its
    // own Prisma client, so no two write the same files.
    projects: [
      {
        extends: true,
        test: {
          name: 'webhooks',
          include: ['tests/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, 'tests/postgres/**', 'tests/mysql/**'],
          globalSetup: postgresSetup,
        },
      },
      {
        extends: true,
        test: {
          name: 'webhooks:postgres-store',
          include: ['tests/postgres/**/*.spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          globalSetup: postgresSetup,
        },
      },
      {
        extends: true,
        test: {
          name: 'webhooks:mysql-store',
          include: ['tests/mysql/**/*.spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // The MySQL server may be shared (here, the nest repo's integration MySQL): at most 4 files at once, each with
          // at most 5 connections, after the other projects' files (vitest runs a project with another worker count in
          // a group of its own). Its stale `whk_` databases are swept before and after the run.
          globalSetup: ['tests/support/generate-prisma-mysql-client.ts', 'tests/support/mysql-global-setup.ts'],
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
