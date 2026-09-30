/**
 * WebhooksModule on PostgresWebhookStore, registered as the docs show it: a factory provider that injects the database
 * DrizzleModule registers and WebhooksStorage. The outbox runs on the store the repo's tests use, DrizzleOutboxStore on
 * the tutorial's migrations (tests/fixtures/drizzle). On PGlite (one connection) and on PostgreSQL (every application
 * its own pool, so workers really race); each test starts without the store's schema, which the store creates at
 * startup.
 */
import { PGlite } from '@electric-sql/pglite';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { WebhooksStorage, type WebhooksEvent } from '../../lib/index.js';
import { fromDrizzle, PostgresWebhookStore } from '../../lib/postgres/index.js';
import { DrizzleOutboxStore } from '../fixtures/database/drizzle-outbox.store.js';
import type { Database } from '../fixtures/database/drizzle.js';
import { controllableClock } from '../helpers.js';
import { inTurn, startReceiver, startSender, STANDARD_SECRET, Transactions, type Receiver, type Sender, type SenderSetup } from '../integration.js';
import { endPool } from '../support/postgres.js';
import { testDatabase } from './support.js';

const migrationsFolder = fileURLToPath(new URL('../fixtures/drizzle', import.meta.url));

const { database: server, reason } = await testDatabase('pgstore_module');

const MIGRATED = '[WebhooksModule] PostgresWebhookStore: migrated schema "nest_webhooks" to version 1.';

interface TestDatabase {
  /** The database one application instance injects: on PostgreSQL, a pool of its own. */
  connect(): Database;
  rows<T = Record<string, unknown>>(statement: string): Promise<T[]>;
  /** Drops the store's schema and empties the application's and the outbox's tables. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const RESET = [
  'DROP SCHEMA IF EXISTS nest_webhooks CASCADE',
  'TRUNCATE outbox_messages, outbox_dead_letters, outbox_inbox, shipments RESTART IDENTITY',
];

async function pgliteDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  const db = drizzlePglite(pglite);
  await migratePglite(db, { migrationsFolder });
  await pglite.exec('CREATE TABLE shipments (order_id text PRIMARY KEY)');
  return {
    connect: () => db as unknown as Database,
    rows: async (statement) => (await pglite.query(statement)).rows as never,
    reset: async () => {
      for (const statement of RESET) {
        await pglite.exec(statement);
      }
    },
    close: () => pglite.close(),
  };
}

async function postgresDatabase(): Promise<TestDatabase> {
  const admin = new pg.Pool({ connectionString: server!.url, max: 2 });
  await migrate(drizzle(admin), { migrationsFolder });
  await admin.query('CREATE TABLE shipments (order_id text PRIMARY KEY)');
  const pools: pg.Pool[] = [];
  return {
    connect: () => {
      const pool = new pg.Pool({ connectionString: server!.url, max: 6 });
      pools.push(pool);
      return drizzle(pool) as Database;
    },
    rows: async (statement) => (await admin.query(statement)).rows,
    async reset() {
      await Promise.all(pools.splice(0).map((pool) => endPool(pool)));
      for (const statement of RESET) {
        await admin.query(statement);
      }
    },
    close: () => endPool(admin),
  };
}

/** The application's transactions: Drizzle's, with a shipments table that commits with them. */
class DrizzleTransactions extends Transactions {
  constructor(private readonly db: Database) {
    super();
  }

  run<T>(work: (tx: any) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async shipped() {
    const { rows } = await this.db.execute<{ order_id: string }>(sql`SELECT order_id FROM shipments ORDER BY order_id`);
    return rows.map((row) => row.order_id);
  }

  async recordShipment(tx: any, orderId: string) {
    await tx.execute(sql`INSERT INTO shipments (order_id) VALUES (${orderId})`);
  }
}

const targets = [
  { label: 'PGlite', open: pgliteDatabase, postgres: false, skip: undefined },
  { label: 'PostgreSQL', open: postgresDatabase, postgres: true, skip: reason },
];

describe.each(targets)('WebhooksModule on PostgresWebhookStore, on $label', ({ open, postgres, skip }) => {
  let database: TestDatabase;
  const apps: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    if (!skip) {
      database = await open();
    }
  });

  afterAll(() => database?.close());

  beforeEach((context) => {
    if (skip) {
      context.skip(skip);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0).reverse()) {
      await app.close();
    }
    await database?.reset();
  });

  /** The store's API, with its webhook store registered as the docs show it, and the outbox on Drizzle. */
  async function sender(options: SenderSetup['options'] = {}): Promise<Sender> {
    const db = database.connect();
    const app = await startSender('express', {
      options,
      imports: [DrizzleModule.forRoot({ db, autoCloseConnection: false })],
      providers: [
        { provide: Transactions, useValue: new DrizzleTransactions(db) },
        {
          provide: PostgresWebhookStore,
          inject: [getDrizzleToken(), WebhooksStorage],
          useFactory: (db: Database, storage: WebhooksStorage) => new PostgresWebhookStore({ executor: fromDrizzle(db) }, storage),
        },
        DrizzleOutboxStore,
      ],
    });
    apps.push(app);
    return app;
  }

  async function partner(): Promise<Receiver> {
    const receiver = await startReceiver('express');
    apps.push(receiver);
    return receiver;
  }

  const count = async (table: string) => (await database.rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;

  it('migrates its schema at startup, then delivers a dispatched event signed, retries a failure after its backoff, logs each attempt, and replays', async () => {
    const clock = controllableClock();
    const receiver = await partner();
    const app = await sender();
    expect(app.logger.lines).toContain(MIGRATED);
    expect(app.logger.lines).toContain('[WebhooksModule] WebhooksStorage: PostgresWebhookStore');

    const { body: endpoint } = await request(app.server())
      .post('/partners/shop-1/webhook-endpoints')
      .send({ url: receiver.url('standard'), eventTypes: ['order.shipped'], secret: STANDARD_SECRET })
      .expect(201);
    const { body: message } = await request(app.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
    await request(app.server()).post('/orders/o-2/ship').send({ tenant: 'shop-1', fail: true }).expect(409);
    expect(await app.transactions.shipped()).toEqual(['o-1']);

    // The partner fails the first attempt: retried after the backoff (1s, factor 2, no jitter), not before.
    receiver.partner.answer = inTurn({ status: 500 }, {});
    expect(await app.flush()).toMatchObject({ claimed: 1, retried: 1 });
    const [delivery] = await app.deliveries.list({ tenant: 'shop-1' });
    expect(delivery).toMatchObject({ messageId: message.id, endpointId: endpoint.id, status: 'pending', attempts: 1, lastStatusCode: 500 });
    expect(app.events.filter((event) => event.type === 'retry-scheduled')).toMatchObject([{ attempt: 1, delayMs: 1_000, statusCode: 500 }]);
    expect(await app.worker.runOnce()).toMatchObject({ claimed: 0 });
    clock.advance(1_000);
    expect(await app.worker.runOnce()).toMatchObject({ claimed: 1, delivered: 1 });

    // Verified by the partner's @VerifyWebhook('standard'), with the same webhook-id both times.
    expect(receiver.partner.of('standard').map((hit) => [hit.id, hit.payload.data.orderId])).toEqual([
      [message.id, 'o-1'],
      [message.id, 'o-1'],
    ]);
    const { body: details } = await request(app.server()).get(`/partners/shop-1/webhook-deliveries/${delivery!.id}`).expect(200);
    expect(details).toMatchObject({ status: 'succeeded', attempts: 2, lastStatusCode: 200, message: { id: message.id, body: message.body } });
    expect(details.history.map((attempt: { attempt: number; statusCode: number }) => [attempt.attempt, attempt.statusCode])).toEqual([
      [1, 500],
      [2, 200],
    ]);

    // A replay: a new round, the same webhook-id, which the partner's inbox recognizes.
    await request(app.server()).post(`/partners/shop-1/webhook-deliveries/${delivery!.id}/retry`).expect(200, { retried: 1 });
    expect(await app.worker.runOnce()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.of('standard')).toHaveLength(2);
    expect((await app.deliveries.get(delivery!.id))!.history.map((attempt) => [attempt.attempt, attempt.statusCode])).toEqual([
      [1, 500],
      [2, 200],
      [1, 200],
    ]);

    expect(await app.deliveries.stats()).toMatchObject({ pending: 0, due: 0, leased: 0, failed: 0, lagMs: 0, inFlight: 0 });
    clock.advance(31 * 24 * 60 * 60_000);
    expect(await app.deliveries.prune('30d')).toBe(1);
    expect([await count('nest_webhooks.deliveries'), await count('nest_webhooks.delivery_attempts'), await count('nest_webhooks.messages')]).toEqual([0, 0, 0]);
  });

  it('keeps what the worker learned in the store: a 410 disables the endpoint, a deleted endpoint fails its delivery without an attempt', async () => {
    const receiver = await partner();
    const app = await sender();
    const gone = await app.endpoints.create({ url: receiver.url('standard'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
    const deleted = await app.endpoints.create({ url: receiver.url('counted'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
    receiver.partner.answer = () => ({ status: 410 });
    await request(app.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
    await app.relay.runOnce();
    await request(app.server()).delete(`/partners/shop-1/webhook-endpoints/${deleted.id}`).expect(204);

    expect(await app.worker.runOnce()).toMatchObject({ failed: 2 });
    expect(await database.rows('SELECT id, enabled, disabled_reason FROM nest_webhooks.endpoints')).toEqual([{ id: gone.id, enabled: false, disabled_reason: 'gone' }]);
    expect(app.events.filter((event) => event.type === 'endpoint-disabled')).toMatchObject([{ endpointId: gone.id, reason: 'gone' }]);
    expect(await database.rows('SELECT endpoint_id, failure_reason, last_error FROM nest_webhooks.deliveries ORDER BY failure_reason')).toEqual([
      { endpoint_id: deleted.id, failure_reason: 'endpoint-deleted', last_error: `Endpoint ${deleted.id} was deleted` },
      { endpoint_id: gone.id, failure_reason: 'rejected', last_error: 'WebhookResponseError: Endpoint responded 410' },
    ]);
    expect(await count('nest_webhooks.delivery_attempts')).toBe(1);
    expect(await app.deliveries.stats()).toMatchObject({ failed: 2, pending: 0 });
  });

  it('keeps endpoint secrets sealed in its table as the module hands them over, and signs with them', async () => {
    const receiver = await partner();
    const app = await sender({ encryption: { keys: ['k'.repeat(32)] } });
    const endpoint = await app.endpoints.create({ url: receiver.url('standard'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });

    const [row] = await database.rows<{ secrets: { secret: string }[] }>('SELECT secrets FROM nest_webhooks.endpoints');
    expect(row!.secrets).toHaveLength(1);
    expect(row!.secrets[0]!.secret).not.toContain(STANDARD_SECRET.slice('whsec_'.length));
    expect(await app.endpoints.getSecret(endpoint.id)).toBe(STANDARD_SECRET);

    await request(app.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
    expect(await app.flush()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.of('standard')).toHaveLength(1);
  });

  it.runIf(postgres)('starts two instances together, which migrate once, and whose workers never deliver a delivery twice', async () => {
    const receiver = await partner();
    const options = { worker: { enabled: false, batchSize: 3, concurrency: 2 } };
    const [first, second] = await Promise.all([sender(options), sender(options)]);
    expect([...first.logger.lines, ...second.logger.lines].filter((line) => line === MIGRATED)).toHaveLength(1);

    await first.endpoints.create({ url: receiver.url('counted'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const app = i % 2 === 0 ? first : second;
      const { body } = await request(app.server()).post(`/orders/o-${i}/ship`).send({ tenant: 'shop-1' }).expect(201);
      ids.push(body.id);
    }

    await Promise.all([first.relay.runOnce(), second.relay.runOnce()]);
    await Promise.all([first.relay.runOnce(), second.relay.runOnce()]);
    expect(await count('nest_webhooks.deliveries')).toBe(12);

    const totals = { claimed: 0, delivered: 0, leaseLost: 0 };
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all([first.worker.runOnce(), second.worker.runOnce()]);
      for (const result of results) {
        totals.claimed += result.claimed;
        totals.delivered += result.delivered;
        totals.leaseLost += result.leaseLost;
      }
      if (results.every((result) => result.claimed === 0)) {
        break;
      }
    }

    expect(totals).toEqual({ claimed: 12, delivered: 12, leaseLost: 0 });
    expect(receiver.partner.of('counted').map((hit) => hit.id).sort()).toEqual([...ids].sort());
    expect(await database.rows('SELECT delivery_id FROM nest_webhooks.delivery_attempts GROUP BY delivery_id HAVING count(*) > 1')).toEqual([]);
    expect(await count('nest_webhooks.delivery_attempts')).toBe(12);
    const delivered = (events: WebhooksEvent[]) => events.filter((event) => event.type === 'delivered').length;
    expect(delivered(first.events) + delivered(second.events)).toBe(12);
  });
});
