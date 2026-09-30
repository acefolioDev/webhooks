/**
 * MySqlWebhookStore's tests: the database clients an application may hand it (mysql2, Drizzle on mysql2, TypeORM,
 * Prisma with its MariaDB adapter, Kysely), and a database per test file on the MySQL of `SQL_TEST_MYSQL_URL` (else
 * those tests are skipped with the reason), through tests/support/mysql.ts, which names (`whk_`) and sweeps them.
 *
 * The server is shared: each client's pool holds at most 4 connections and a file's admin pool 1, so a file never has
 * more than 5 open, and the MySQL project runs at most 4 files at once.
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { drizzle } from 'drizzle-orm/mysql2';
import { Kysely, MysqlDialect } from 'kysely';
import mysqlCallbacks from 'mysql2';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { fromDrizzle, fromKysely, fromMysql2, fromPrisma, fromTypeOrm, MySqlWebhookStore, type SqlExecutor } from '../../lib/mysql/index.js';
import { webhookDeliveryStoreContract, webhookEndpointStoreContract } from '../../lib/testing/index.js';
import { PrismaClient } from '../fixtures/prisma-mysql/generated/client.js';
import { startMysql } from '../support/mysql.js';

/** The connections each client's pool may open. */
export const POOL_SIZE = 4;

/** A database client as an application holds one, and the executor the store takes of it. */
export interface Client {
  name: string;
  executor: SqlExecutor;
  close(): Promise<void>;
}

export interface ClientFactory {
  name: string;
  open(url: string, options?: { poolSize?: number }): Promise<Client>;
}

export const mysql2Client: ClientFactory = {
  name: 'fromMysql2 (mysql2 pool)',
  async open(url, { poolSize = POOL_SIZE } = {}) {
    const pool = mysql.createPool({ uri: url, connectionLimit: poolSize });
    return { name: this.name, executor: fromMysql2(pool), close: () => pool.end() };
  },
};

export const drizzleClient: ClientFactory = {
  name: 'fromDrizzle (mysql2)',
  async open(url, { poolSize = POOL_SIZE } = {}) {
    const pool = mysql.createPool({ uri: url, connectionLimit: poolSize });
    return { name: this.name, executor: fromDrizzle(drizzle(pool)), close: () => pool.end() };
  },
};

export const typeOrmClient: ClientFactory = {
  name: 'fromTypeOrm',
  async open(url, { poolSize = POOL_SIZE } = {}) {
    const dataSource = await new DataSource({ type: 'mysql', url, poolSize }).initialize();
    return { name: this.name, executor: fromTypeOrm(dataSource), close: () => dataSource.destroy() };
  },
};

export const prismaClient: ClientFactory = {
  name: 'fromPrisma (@prisma/adapter-mariadb)',
  async open(url, { poolSize = POOL_SIZE } = {}) {
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb(mariadbConfig(url, poolSize)) });
    return { name: this.name, executor: fromPrisma(prisma), close: () => prisma.$disconnect() };
  },
};

export const kyselyClient: ClientFactory = {
  name: 'fromKysely',
  async open(url, { poolSize = POOL_SIZE } = {}) {
    const db = new Kysely<Record<string, never>>({ dialect: new MysqlDialect({ pool: mysqlCallbacks.createPool({ uri: url, connectionLimit: poolSize }) }) });
    return { name: this.name, executor: fromKysely(db), close: () => db.destroy() };
  },
};

/** Every client on MySQL. */
export const clients = [mysql2Client, drizzleClient, typeOrmClient, prismaClient, kyselyClient];

/**
 * The MariaDB connector's settings for `url`. `allowPublicKeyRetrieval`: MySQL's `caching_sha2_password` over a
 * connection without TLS needs the server's RSA key until the server has cached the password (a fresh server, as in CI).
 */
export function mariadbConfig(url: string, connectionLimit = POOL_SIZE) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionLimit,
    allowPublicKeyRetrieval: true,
  };
}

export interface TestDatabase {
  /** The database's name. */
  name: string;
  url: string;
  /** One connection for looking at the database from outside the store. */
  admin: mysql.Pool;
}

/**
 * A database of this test file on MySQL, dropped after the file; `null`, with the reason, where there's no MySQL. Tests
 * that need it skip with the reason.
 */
export async function testDatabase(name: string): Promise<{ database: TestDatabase; reason?: undefined } | { database: null; reason: string }> {
  const { mysql: server, reason } = await startMysql();
  if (!server) {
    return { database: null, reason: `no MySQL: ${reason}` };
  }

  const { name: database, url } = await server.createDatabase(name);
  const admin = mysql.createPool({ uri: url, connectionLimit: 1 });
  // A statement the tests run from outside waits 30 seconds for a table's metadata lock, not a year.
  admin.on('connection', (connection) => {
    connection.query('SET SESSION lock_wait_timeout = 30');
  });
  afterAll(async () => {
    await admin.end();
    await server.stop();
  });
  return { database: { name: database, url, admin } };
}

/** In a describe of tests that run on MySQL: skips them, with the reason, where there's none. */
export function onMysql(reason: string | undefined): void {
  beforeEach((context) => {
    if (reason) {
      context.skip(reason);
    }
  });
}

/** The store's tables in `schema`: `<schema>_<table>`, quoted. */
export const tables = (schema: string) => ({
  endpoints: `\`${schema}_endpoints\``,
  messages: `\`${schema}_messages\``,
  deliveries: `\`${schema}_deliveries\``,
  attempts: `\`${schema}_delivery_attempts\``,
});

/** Empties the store's tables in `schema`, as the contracts want a store on empty tables (DML: no metadata locks). */
export async function truncate(executor: SqlExecutor, schema: string): Promise<void> {
  const t = tables(schema);
  for (const table of [t.attempts, t.deliveries, t.messages, t.endpoints]) {
    await executor.execute(`DELETE FROM ${table}`);
  }
}

/**
 * Both store contracts on MySqlWebhookStore through `client`, with the concurrency cases: each case on emptied tables,
 * with a store built as an application builds it (the server and its tables checked at the first call).
 */
export function describeContract(label: string, client: () => Promise<Client | null>, schema: string, skipReason?: string): void {
  describe(label, () => {
    let opened: Client | null = null;
    beforeAll(async () => {
      opened = await client();
      if (opened) {
        await new MySqlWebhookStore({ executor: opened.executor, schema }).migrate();
      }
    });
    afterAll(() => opened?.close());
    if (skipReason) {
      beforeEach((context) => context.skip(skipReason));
    }

    const harness = async () => {
      await truncate(opened!.executor, schema);
      return { store: new MySqlWebhookStore({ executor: opened!.executor, schema, migrate: false }) };
    };

    describe('the endpoint contract', () => {
      for (const c of webhookEndpointStoreContract(harness, { concurrent: true })) {
        it(c.name, c.run);
      }
    });

    describe('the delivery contract', () => {
      for (const c of webhookDeliveryStoreContract(harness, { concurrent: true })) {
        it(c.name, c.run);
      }
    });
  });
}

/** An executor that records every statement it runs, and its parameters. */
export function recording(executor: SqlExecutor): { executor: SqlExecutor; statements: Array<{ text: string; params?: readonly unknown[] }> } {
  const statements: Array<{ text: string; params?: readonly unknown[] }> = [];
  const record = (tx: Pick<SqlExecutor, 'query' | 'execute'>) => ({
    query: <R extends object>(text: string, params?: readonly unknown[]) => {
      statements.push({ text, params });
      return tx.query<R>(text, params);
    },
    execute: (text: string, params?: readonly unknown[]) => {
      statements.push({ text, params });
      return tx.execute(text, params);
    },
  });
  return {
    statements,
    executor: {
      dialect: executor.dialect,
      query: (text, params) => record(executor).query(text, params),
      execute: (text, params) => record(executor).execute(text, params),
      transaction: (work, options) => executor.transaction((tx) => work(record(tx)), options),
      wrapTransaction: (transaction) => record(executor.wrapTransaction(transaction)),
    },
  };
}
