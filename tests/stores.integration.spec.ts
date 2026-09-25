/**
 * The sender and the receiver on the database recipes the docs ship: the webhooks tutorial's
 * `DrizzleWebhookStore` (endpoints, messages, deliveries, attempts) and `DrizzleOutboxStore`
 * (the outbox that carries `dispatch()` out of the transaction, and the receiver's inbox), with
 * the tutorial's drizzle-kit migrations (copies in tests/fixtures/), on PGlite (in-process, one
 * connection) and on PostgreSQL (SQL_TEST_PG_URL, else a throwaway cluster, skipped with the
 * reason when the binaries are missing; every application instance has its own pool, so
 * transactions really overlap).
 */
import { PGlite } from '@electric-sql/pglite';
import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { OutboxStorage } from '@nestjs/outbox';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { adapters, type AdapterName } from './support/adapters.js';
import { startPostgres } from './support/postgres.js';
import { IncomingWebhook, VerifyWebhook, WebhooksStorage } from '../lib/index.js';
import { signWebhook } from '../lib/testing/index.js';
import { DrizzleOutboxStore } from './fixtures/database/drizzle-outbox.store.js';
import { DrizzleWebhookStore } from './fixtures/database/drizzle-webhook.store.js';
import { controllableClock } from './helpers.js';
import { startReceiver, startSender, STANDARD_SECRET, Transactions, type Receiver, type Sender, type SenderSetup } from './integration.js';

const migrationsFolder = fileURLToPath(new URL('./fixtures/drizzle', import.meta.url));

const { postgres, reason } = await startPostgres();
afterAll(() => postgres?.stop());

/** A Drizzle database of the tutorial's (node-postgres or PGlite; the recipes take either). */
type Database = any;

interface TestDatabase {
  /** The database one application instance injects: on PostgreSQL, a pool of its own. */
  connect(): Database;
  rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** The application's own tables, written in the same transactions as the recipes' rows. */
async function createAppTables(db: Database) {
  await db.execute(sql`CREATE TABLE shipments (order_id text PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE payments (order_id text NOT NULL, webhook_id text NOT NULL)`);
}

const ALL_TABLES = sql`TRUNCATE webhook_delivery_attempts, webhook_deliveries, webhook_messages, webhook_endpoints,
  outbox_messages, outbox_dead_letters, outbox_inbox, shipments, payments RESTART IDENTITY`;

async function pgliteDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzlePglite(client);
  await migratePglite(db, { migrationsFolder });
  await createAppTables(db);
  return {
    connect: () => db,
    rows: async (query) => (await db.execute(query)).rows as never,
    reset: async () => {
      await db.execute(ALL_TABLES);
    },
    close: () => client.close(),
  };
}

async function postgresDatabase(): Promise<TestDatabase> {
  const url = await postgres!.createDatabase('webhooks_integration');
  const pools: pg.Pool[] = [];
  const connect = () => {
    const pool = new pg.Pool({ connectionString: url, max: 6 });
    pools.push(pool);
    return drizzle(pool);
  };
  const admin = connect();
  await migrate(admin, { migrationsFolder });
  await createAppTables(admin);
  return {
    connect,
    rows: async (query) => (await admin.execute(query)).rows as never,
    async reset() {
      // The pools of the applications closed since: only the first one, for assertions, stays open.
      for (const pool of pools.splice(1)) {
        await pool.end();
      }
      await admin.execute(ALL_TABLES);
    },
    close: async () => {
      for (const pool of pools) {
        await pool.end();
      }
    },
  };
}

class DrizzleTransactions extends Transactions {
  constructor(private readonly db: Database) {
    super();
  }

  run<T>(work: (tx: any) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async shipped() {
    const { rows } = await this.db.execute(sql`SELECT order_id FROM shipments ORDER BY order_id`);
    return rows.map((row: { order_id: string }) => row.order_id);
  }

  async recordShipment(tx: any, orderId: string) {
    await tx.execute(sql`INSERT INTO shipments (order_id) VALUES (${orderId})`);
  }
}

const DB = Symbol('DB');

/** The partner books the payment and records the webhook id in one transaction: exactly once. */
@Controller('payments')
class PaymentsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Post()
  @HttpCode(200)
  @VerifyWebhook('standard')
  paid(@IncomingWebhook() webhook: IncomingWebhook<{ data: { orderId: string } }>) {
    return this.db.transaction((tx: any) =>
      webhook.processInTransaction(tx, async () => {
        await tx.execute(sql`INSERT INTO payments (order_id, webhook_id) VALUES (${webhook.payload.data.orderId}, ${webhook.id})`);
        return 'booked';
      }),
    );
  }
}

const targets = [
  { label: 'PGlite', open: pgliteDatabase, skip: false },
  { label: `PostgreSQL${postgres ? '' : ` (skipped: ${reason})`}`, open: postgresDatabase, skip: !postgres },
];

for (const target of targets) {
  describe.skipIf(target.skip)(`the tutorial's Drizzle recipes on ${target.label}`, { timeout: 20_000 }, () => {
    let database: TestDatabase;
    const apps: { close(): Promise<void> }[] = [];

    beforeAll(async () => {
      database = await target.open();
    }, 30_000);
    afterAll(() => database?.close());
    afterEach(async () => {
      vi.restoreAllMocks();
      for (const app of apps.splice(0).reverse()) {
        await app.close();
      }
      await database.reset();
    });

    /** The store on the recipes: its webhook store and its outbox on the database, its transactions Drizzle's. */
    async function store(adapter: AdapterName, options: SenderSetup['options'] = {}): Promise<Sender> {
      const db = database.connect();
      const sender = await startSender(adapter, {
        options,
        providers: [
          { provide: Transactions, useValue: new DrizzleTransactions(db) },
          { provide: DrizzleWebhookStore, inject: [WebhooksStorage], useFactory: (storage: WebhooksStorage) => new DrizzleWebhookStore(db, storage) },
          { provide: DrizzleOutboxStore, inject: [OutboxStorage], useFactory: (storage: OutboxStorage) => new DrizzleOutboxStore(db, storage) },
        ],
      });
      apps.push(sender);
      return sender;
    }

    /** The partner, its inbox on the database. */
    async function partner(adapter: AdapterName): Promise<Receiver> {
      const db = database.connect();
      const receiver = await startReceiver(adapter, {
        controllers: [PaymentsController],
        providers: [
          { provide: DB, useValue: db },
          { provide: DrizzleOutboxStore, inject: [OutboxStorage], useFactory: (storage: OutboxStorage) => new DrizzleOutboxStore(db, storage) },
        ],
      });
      apps.push(receiver);
      return receiver;
    }

    const count = async (table: string) => Number((await database.rows<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]!.n);

    describe.each(adapters.map((a) => a.name))('on %s', (adapter) => {
      it('commits the webhook with the shipment, and the partner books the payment with its inbox record, once', async () => {
        const clock = controllableClock();
        const receiver = await partner(adapter);
        const sender = await store(adapter);
        const url = `http://127.0.0.1:${receiver.port}/payments`;
        const { body: endpoint } = await request(sender.server())
          .post('/partners/shop-1/webhook-endpoints')
          .send({ url, eventTypes: ['order.shipped'], secret: STANDARD_SECRET })
          .expect(201);

        const { body: message } = await request(sender.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
        await request(sender.server()).post('/orders/o-2/ship').send({ tenant: 'shop-1', fail: true }).expect(409);
        expect(await sender.transactions.shipped()).toEqual(['o-1']);
        expect(await database.rows(sql`SELECT id FROM outbox_messages`)).toEqual([{ id: message.id }]);

        expect(await sender.flush()).toMatchObject({ claimed: 1, delivered: 1 });
        expect(await database.rows(sql`SELECT order_id, webhook_id FROM payments`)).toEqual([{ order_id: 'o-1', webhook_id: message.id }]);
        expect(await database.rows(sql`SELECT consumer, message_id FROM outbox_inbox`)).toEqual([{ consumer: 'webhooks:standard', message_id: message.id }]);
        expect(await database.rows(sql`SELECT endpoint_id, status, attempts, last_status_code FROM webhook_deliveries`)).toEqual([
          { endpoint_id: endpoint.id, status: 'succeeded', attempts: 1, last_status_code: 200 },
        ]);
        expect(await database.rows(sql`SELECT body FROM webhook_messages`)).toEqual([{ body: message.body }]);

        // A replay: the same webhook-id, a 2xx, and the payment not booked twice.
        const [delivery] = await sender.deliveries.list({ tenant: 'shop-1' });
        await request(sender.server()).post(`/partners/shop-1/webhook-deliveries/${delivery!.id}/retry`).expect(200, { retried: 1 });
        expect(await sender.worker.runOnce()).toMatchObject({ delivered: 1 });
        expect(await count('payments')).toBe(1);
        const { body: details } = await request(sender.server()).get(`/partners/shop-1/webhook-deliveries/${delivery!.id}`).expect(200);
        expect(details.history.map((attempt: { attempt: number; statusCode: number }) => [attempt.attempt, attempt.statusCode])).toEqual([
          [1, 200],
          [1, 200],
        ]);

        expect(await sender.deliveries.stats()).toMatchObject({ pending: 0, due: 0, leased: 0, failed: 0, lagMs: 0, inFlight: 0 });
        clock.advance(31 * 24 * 60 * 60_000);
        expect(await sender.deliveries.prune('30d')).toBe(1);
        expect([await count('webhook_deliveries'), await count('webhook_delivery_attempts'), await count('webhook_messages')]).toEqual([0, 0, 0]);
      });

      it('never delivers one message twice with two worker instances on one database', async () => {
        const receiver = await partner(adapter);
        const options = { worker: { enabled: false, batchSize: 3, concurrency: 2 } };
        const [first, second] = [await store(adapter, options), await store(adapter, options)];
        await first.endpoints.create({ url: receiver.url('counted'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
        const ids: string[] = [];
        for (let i = 1; i <= 12; i++) {
          const sender = i % 2 === 0 ? first : second;
          const { body } = await request(sender.server()).post(`/orders/o-${i}/ship`).send({ tenant: 'shop-1' }).expect(201);
          ids.push(body.id);
        }

        await Promise.all([first.relay.runOnce(), second.relay.runOnce()]);
        await Promise.all([first.relay.runOnce(), second.relay.runOnce()]);
        expect(await count('webhook_deliveries')).toBe(12);

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
        expect(await database.rows(sql`SELECT delivery_id FROM webhook_delivery_attempts GROUP BY delivery_id HAVING count(*) > 1`)).toEqual([]);
        expect(await count('webhook_delivery_attempts')).toBe(12);
      });

      it("books a webhook once when two of the partner's instances receive it at the same moment", async () => {
        const [first, second] = [await partner(adapter), await partner(adapter)];
        const { body, headers } = signWebhook({ scheme: 'standard', secret: STANDARD_SECRET, payload: { type: 'order.shipped', data: { orderId: 'o-1' } } });

        const responses = await Promise.all(
          [first, second, first, second].map((receiver) => request(receiver.app.getHttpServer()).post('/payments').set(headers).send(body)),
        );

        expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
        expect(await database.rows(sql`SELECT order_id, webhook_id FROM payments`)).toEqual([{ order_id: 'o-1', webhook_id: headers['webhook-id'] }]);
        expect(await count('outbox_inbox')).toBe(1);
      });

      it("seals endpoint secrets in the recipe's table, and signs with them", async () => {
        const receiver = await partner(adapter);
        const sender = await store(adapter, { encryption: { keys: ['k'.repeat(32)] } });
        const endpoint = await sender.endpoints.create({ url: receiver.url('standard'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });

        const [row] = await database.rows<{ secrets: { secret: string }[] }>(sql`SELECT secrets FROM webhook_endpoints`);
        expect(row!.secrets).toHaveLength(1);
        expect(row!.secrets[0]!.secret).not.toContain(STANDARD_SECRET.slice('whsec_'.length));
        expect(await sender.endpoints.getSecret(endpoint.id)).toBe(STANDARD_SECRET);

        await request(sender.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
        expect(await sender.flush()).toMatchObject({ delivered: 1 });
        expect(receiver.partner.of('standard')).toHaveLength(1);
      });

      it('keeps what the worker learned about an endpoint in the database: gone, and a pending delivery failed without an attempt', async () => {
        const receiver = await partner(adapter);
        const sender = await store(adapter);
        const gone = await sender.endpoints.create({ url: receiver.url('standard'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
        const deleted = await sender.endpoints.create({ url: receiver.url('counted'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
        receiver.partner.answer = () => ({ status: 410 });
        await request(sender.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
        await sender.relay.runOnce();
        await request(sender.server()).delete(`/partners/shop-1/webhook-endpoints/${deleted.id}`).expect(204);

        expect(await sender.worker.runOnce()).toMatchObject({ failed: 2 });
        expect(await database.rows(sql`SELECT id, enabled, disabled_reason FROM webhook_endpoints`)).toEqual([{ id: gone.id, enabled: false, disabled_reason: 'gone' }]);
        const rows = await database.rows<{ endpoint_id: string; failure_reason: string }>(
          sql`SELECT endpoint_id, failure_reason FROM webhook_deliveries ORDER BY failure_reason`,
        );
        expect(rows).toEqual([
          { endpoint_id: deleted.id, failure_reason: 'endpoint-deleted' },
          { endpoint_id: gone.id, failure_reason: 'rejected' },
        ]);
        expect(await count('webhook_delivery_attempts')).toBe(1);
        expect(receiver.partner.of('counted')).toEqual([]);
      });
    });
  });
}
