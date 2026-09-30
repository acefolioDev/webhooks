/**
 * The store contracts (`@nestjs/webhooks/testing`) on the hand-written store the docs showed before the first-party one
 * (tests/fixtures/database/drizzle-webhook.store.ts): a store written by hand, with an ORM and without the kit, passes
 * them too, races included. On PGlite, and on PostgreSQL (SQL_TEST_PG_URL, else a throwaway cluster, skipped with the
 * reason when there's none), where transactions really overlap. PostgresWebhookStore's own runs are in tests/postgres.
 */
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { WebhooksStorage } from '../lib/index.js';
import { webhookDeliveryStoreContract, webhookEndpointStoreContract } from '../lib/testing/index.js';
import { DrizzleWebhookStore } from './fixtures/database/drizzle-webhook.store.js';
import type { Database } from './fixtures/database/drizzle.js';
import { endPool, startPostgres } from './support/postgres.js';

const migrationsFolder = fileURLToPath(new URL('./fixtures/drizzle', import.meta.url));

const { postgres, reason } = await startPostgres();
afterAll(() => postgres?.stop());

const targets = [
  {
    label: 'PGlite',
    skip: undefined,
    async open() {
      const pglite = new PGlite();
      const db = drizzlePglite(pglite);
      await migratePglite(db, { migrationsFolder });
      return { db: db as unknown as Database, close: () => pglite.close() };
    },
  },
  {
    label: 'PostgreSQL',
    skip: reason,
    async open() {
      const pool = new pg.Pool({ connectionString: await postgres!.createDatabase('webhooks_drizzle_contract'), max: 10 });
      const db = drizzle(pool) as Database;
      await migrate(db, { migrationsFolder });
      return { db, close: () => endPool(pool) };
    },
  },
];

describe.each(targets)('the hand-written DrizzleWebhookStore on $label', ({ open, skip }) => {
  let opened: Awaited<ReturnType<typeof open>> | undefined;

  beforeAll(async () => {
    if (!skip) {
      opened = await open();
    }
  });

  afterAll(() => opened?.close());

  beforeEach((context) => {
    if (skip) {
      context.skip(skip);
    }
  });

  const harness = async () => {
    await opened!.db.execute(sql`TRUNCATE webhook_delivery_attempts, webhook_deliveries, webhook_messages, webhook_endpoints RESTART IDENTITY`);
    return { store: new DrizzleWebhookStore(opened!.db, new WebhooksStorage()) };
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
