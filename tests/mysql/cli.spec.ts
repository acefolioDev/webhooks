/**
 * The `nest-webhooks` command on MySQL (lib/cli.ts: the kit's runStoreCli() on both stores' schemas; a mysql:// URL
 * picks MySqlWebhookStore's): `sql --dialect mysql` prints what migrationSql() does, `migrate` applies the migrations,
 * `status` exits with 1 while the tables are behind, and a database it can't migrate says where it stopped.
 */
import { MySqlWebhookStore } from '../../lib/mysql/index.js';
import { PostgresWebhookStore } from '../../lib/postgres/index.js';
import { runCli as run } from '../support/cli.js';
import { onMysql, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_cli');

describe('nest-webhooks for MySqlWebhookStore', () => {
  it("sql --dialect mysql prints MySQL's migrations as migrationSql() does, without a database; PostgreSQL's stay the default", async () => {
    expect(await run(['sql', '--dialect', 'mysql'])).toEqual({ code: 0, out: MySqlWebhookStore.migrationSql(), err: '' });
    expect(await run(['sql', '--dialect', 'mysql', '--schema', 'shop_webhooks', '--from', '0', '--to', '1'])).toEqual({
      code: 0,
      out: MySqlWebhookStore.migrationSql({ schema: 'shop_webhooks', from: 0, to: 1 }),
      err: '',
    });
    expect(await run(['sql', '--dialect', 'mysql', '--statement-breakpoints'])).toEqual({
      code: 0,
      out: MySqlWebhookStore.migrationSql({ statementBreakpoints: true }),
      err: '',
    });
    expect((await run(['sql'])).out).toBe(PostgresWebhookStore.migrationSql());
    expect((await run(['sql', '--dialect', 'mysql', '--schema', 'Shop'])).err).toContain('MySqlWebhookStore: invalid schema "Shop".');
    expect(await run(['sql', '--dialect', 'oracle'])).toEqual({ code: 1, out: '', err: '--dialect takes postgres or mysql, not "oracle".\n' });
  });

  it('prints a usage that names both stores, and how each migrates', async () => {
    const help = await run(['--help']);
    expect(help).toMatchObject({ code: 0, err: '' });
    expect(help.out).toContain("PostgresWebhookStore's schema (@nestjs/webhooks/postgres):\nMySqlWebhookStore's schema (@nestjs/webhooks/mysql):");
    expect(help.out).toContain('MySQL: one statement at a time, under GET_LOCK(), resuming where a failed run stopped)');
    expect(help.out).toContain('--url <url>        The database (postgres://... or mysql://...). Default: $DATABASE_URL');
  });

  describe('on MySQL', () => {
    onMysql(reason);

    it('migrate applies the pending migrations once, and status exits with 1 until they are', async () => {
      const url = database!.url;
      expect(await run(['status', '--url', url, '--schema', 'cli_store'])).toEqual({
        code: 1,
        out: 'Schema "cli_store" is at version 0; this version of @nestjs/webhooks needs version 1.\n',
        err: '',
      });
      expect(await run(['migrate', '--schema', 'cli_store'], { DATABASE_URL: url })).toEqual({
        code: 0,
        out: 'Migrated schema "cli_store" to version 1 (applied 1).\n',
        err: '',
      });
      expect(await run(['migrate', '--url', url, '--schema', 'cli_store'])).toEqual({ code: 0, out: 'Schema "cli_store" is up to date (version 1).\n', err: '' });
      expect(await run(['status', '--url', url, '--schema', 'cli_store'])).toMatchObject({
        code: 0,
        out: 'Schema "cli_store" is at version 1; this version of @nestjs/webhooks needs version 1.\n',
      });
      expect((await database!.admin.query('SELECT version FROM cli_store_migrations'))[0]).toEqual([{ version: 1 }]);
    });

    it('reports a database it cannot migrate, where it stopped, and exits with 1', async () => {
      await database!.admin.query('CREATE TABLE cli_taken_endpoints (id int NOT NULL PRIMARY KEY)');
      expect(await run(['migrate', '--url', database!.url, '--schema', 'cli_taken'])).toEqual({
        code: 1,
        out: '',
        err:
          'MySqlWebhookStore: migrating schema "cli_taken" from version 0 to 1 stopped at migration 1 (initial), statement 1 of 4: ' +
          "Table 'cli_taken_endpoints' already exists. The statements before it are applied, and migrating again resumes at it.\n",
      });
    });
  });
});
