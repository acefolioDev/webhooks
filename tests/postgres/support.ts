/**
 * PostgresWebhookStore's tests: the database clients an application may hand it (node-postgres, Drizzle on node-postgres
 * and on PGlite, TypeORM, Prisma, Kysely), and a database per test file on PostgreSQL (`SQL_TEST_PG_URL`, else a
 * throwaway cluster, else those tests are skipped with the reason), through tests/support/postgres.ts, which names and
 * sweeps them.
 */
import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { fromDrizzle, fromKysely, fromPg, fromPrisma, fromTypeOrm, PostgresWebhookStore, type SqlExecutor } from '../../lib/postgres/index.js';
import { webhookDeliveryStoreContract, webhookEndpointStoreContract } from '../../lib/testing/index.js';
import { PrismaClient } from '../fixtures/prisma/generated/client.js';
import { endPool, startPostgres } from '../support/postgres.js';

/** A database client as an application holds one, and the executor the store takes of it. */
export interface Client {
  name: string;
  executor: SqlExecutor<'postgres'>;
  close(): Promise<void>;
}

export interface ClientFactory {
  name: string;
  open(url: string): Promise<Client>;
}

export const pgClient: ClientFactory = {
  name: 'fromPg (node-postgres Pool)',
  async open(url) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return { name: this.name, executor: fromPg(pool), close: () => endPool(pool) };
  },
};

export const drizzleClient: ClientFactory = {
  name: 'fromDrizzle (node-postgres)',
  async open(url) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return { name: this.name, executor: fromDrizzle(drizzlePg(pool)), close: () => endPool(pool) };
  },
};

export const typeOrmClient: ClientFactory = {
  name: 'fromTypeOrm',
  async open(url) {
    const dataSource = await new DataSource({ type: 'postgres', url, poolSize: 10 }).initialize();
    return { name: this.name, executor: fromTypeOrm(dataSource), close: () => dataSource.destroy() };
  },
};

export const prismaClient: ClientFactory = {
  name: 'fromPrisma (@prisma/adapter-pg)',
  async open(url) {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10 }) });
    return { name: this.name, executor: fromPrisma(prisma), close: () => prisma.$disconnect() };
  },
};

export const kyselyClient: ClientFactory = {
  name: 'fromKysely',
  async open(url) {
    const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }) });
    return { name: this.name, executor: fromKysely(db), close: () => db.destroy() };
  },
};

/** Every client on PostgreSQL. */
export const clients = [pgClient, drizzleClient, typeOrmClient, prismaClient, kyselyClient];

/** Drizzle on PGlite: PostgreSQL in-process, one connection, so every transaction waits for the one before it. */
export async function openPglite(): Promise<Client & { pglite: PGlite }> {
  const pglite = new PGlite();
  return { name: 'fromDrizzle (PGlite)', pglite, executor: fromDrizzle(drizzlePglite(pglite)), close: () => pglite.close() };
}

export interface TestDatabase {
  url: string;
  /** A client for looking at the database from outside the store. */
  admin: pg.Pool;
}

/**
 * A database of this test file on PostgreSQL, dropped after the file; `null`, with the reason, where there's no
 * PostgreSQL. Tests that need it skip with the reason.
 */
export async function testDatabase(name: string): Promise<{ database: TestDatabase; reason?: undefined } | { database: null; reason: string }> {
  const { postgres, reason } = await startPostgres();
  if (!postgres) {
    return { database: null, reason: `no PostgreSQL: ${reason}` };
  }

  const url = await postgres.createDatabase(name);
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  afterAll(async () => {
    await endPool(admin);
    await postgres.stop();
  });
  return { database: { url, admin } };
}

/** Empties the store's tables in `schema`, as the contracts want a store on empty tables. */
export async function truncate(executor: SqlExecutor, schema: string): Promise<void> {
  const tables = ['delivery_attempts', 'deliveries', 'messages', 'endpoints'].map((table) => `"${schema}".${table}`);
  await executor.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`);
}

/**
 * Both store contracts on PostgresWebhookStore through `client`, in a schema of its own, with the concurrency cases:
 * each case on emptied tables, with a store built as an application builds it (its schema checked at the first call).
 */
export function describeContract(label: string, client: () => Promise<Client | null>, schema: string, skipReason?: string): void {
  describe(label, () => {
    let opened: Client | null = null;
    beforeAll(async () => {
      opened = await client();
      if (opened) {
        await new PostgresWebhookStore({ executor: opened.executor, schema }).migrate();
      }
    });
    afterAll(() => opened?.close());
    if (skipReason) {
      beforeEach((context) => context.skip(skipReason));
    }

    const harness = async () => {
      await truncate(opened!.executor, schema);
      return { store: new PostgresWebhookStore({ executor: opened!.executor, schema, migrate: false }) };
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
