/**
 * The executor types a user writes, from this package's entries: `SqlExecutor` from `@nestjs/webhooks/postgres` is a
 * PostgreSQL executor, which PostgresWebhookStore takes, and from `@nestjs/webhooks/mysql` a MySQL one, which
 * MySqlWebhookStore takes, so `const executor: SqlExecutor = fromDrizzle(db)` compiles for its dialect's store. The
 * other dialect's is a compile error (the `@ts-expect-error` lines, which the package's typecheck checks) and a
 * TypeError at run time. Nothing connects: the pools open their connections at their first statement.
 */
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { createPool } from 'mysql2/promise';
import pg from 'pg';
import { fromDrizzle as fromMysqlDrizzle, MySqlWebhookStore, type SqlExecutor as MySqlSqlExecutor } from '../../lib/mysql/index.js';
import { fromDrizzle, PostgresWebhookStore, type SqlExecutor } from '../../lib/postgres/index.js';

describe("the executor types of the package's entries", () => {
  it("takes an executor annotated with /postgres's SqlExecutor in PostgresWebhookStore, and with /mysql's in MySqlWebhookStore, and neither in the other", async () => {
    const pgPool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const mysqlPool = createPool({ host: '127.0.0.1', port: 1, connectionLimit: 1 });
    try {
      const postgres: SqlExecutor = fromDrizzle(drizzlePostgres(pgPool));
      const mysql: MySqlSqlExecutor = fromMysqlDrizzle(drizzleMysql(mysqlPool));
      expect(new PostgresWebhookStore({ executor: postgres })).toBeInstanceOf(PostgresWebhookStore);
      expect(new MySqlWebhookStore({ executor: mysql })).toBeInstanceOf(MySqlWebhookStore);

      // @ts-expect-error A MySQL executor in PostgresWebhookStore's options
      expect(() => new PostgresWebhookStore({ executor: mysql })).toThrow('PostgresWebhookStore runs on PostgreSQL, and `executor` is a MySQL executor');
      // @ts-expect-error A PostgreSQL executor in MySqlWebhookStore's options
      expect(() => new MySqlWebhookStore({ executor: postgres })).toThrow('MySqlWebhookStore runs on MySQL, and `executor` is a PostgreSQL executor');
    } finally {
      await pgPool.end();
      await mysqlPool.end();
    }
  });
});
