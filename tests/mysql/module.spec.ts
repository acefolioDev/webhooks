/**
 * WebhooksModule on MySqlWebhookStore, registered as the docs show it: a factory provider that injects the database
 * DrizzleModule registers (drizzle-orm/mysql2) and WebhooksStorage. The outbox runs on its in-memory store:
 * @nestjs/outbox 0.0.1 has no MySQL store, and no method of the webhook store takes the application's transaction (the
 * outbox carries a dispatched message out of it). Every application instance has a pool of its own, so workers really
 * race; each test starts without the store's tables, which the store creates at startup.
 */
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { WebhooksStorage, type WebhooksEvent } from '../../lib/index.js';
import { fromDrizzle, MySqlWebhookStore } from '../../lib/mysql/index.js';
import { controllableClock } from '../helpers.js';
import { InMemoryTransactions, inTurn, startReceiver, startSender, STANDARD_SECRET, Transactions, type Receiver, type Sender, type SenderSetup } from '../integration.js';
import { onMysql, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_module');

const MIGRATED = '[WebhooksModule] MySqlWebhookStore: migrated schema "nest_webhooks" to version 1.';

/** The store's tables and the kit's, dropped after each test: the next one starts without them. */
const TABLES = ['delivery_attempts', 'deliveries', 'messages', 'endpoints', 'locks', 'migrations'].map((table) => `nest_webhooks_${table}`);

describe('WebhooksModule on MySqlWebhookStore', () => {
  onMysql(reason);

  const apps: { close(): Promise<void> }[] = [];
  const pools: mysql.Pool[] = [];

  const rows = async <T = Record<string, unknown>>(statement: string) => (await database!.admin.query(statement))[0] as T[];
  const count = async (table: string) => (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n;

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0).reverse()) {
      await app.close();
    }
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    if (!reason) {
      for (const table of TABLES) {
        await rows(`DROP TABLE IF EXISTS ${table}`);
      }
    }
  });

  /** The store's API, with its webhook store registered as the docs show it, on a pool of its own. */
  async function sender(options: SenderSetup['options'] = {}): Promise<Sender> {
    const pool = mysql.createPool({ uri: database!.url, connectionLimit: 2 });
    pools.push(pool);
    const db = drizzle(pool);
    const app = await startSender('express', {
      options,
      imports: [DrizzleModule.forRoot({ db, autoCloseConnection: false })],
      providers: [
        { provide: Transactions, useClass: InMemoryTransactions },
        {
          provide: MySqlWebhookStore,
          inject: [getDrizzleToken(), WebhooksStorage],
          useFactory: (db: MySql2Database, storage: WebhooksStorage) => new MySqlWebhookStore({ executor: fromDrizzle(db) }, storage),
        },
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

  it('migrates its tables at startup, then delivers a dispatched event signed, retries a failure after its backoff, logs each attempt, and replays', async () => {
    const clock = controllableClock();
    const receiver = await partner();
    const app = await sender();
    expect(app.logger.lines).toContain(MIGRATED);
    expect(app.logger.lines).toContain('[WebhooksModule] WebhooksStorage: MySqlWebhookStore');

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
    expect([await count('nest_webhooks_deliveries'), await count('nest_webhooks_delivery_attempts'), await count('nest_webhooks_messages')]).toEqual([0, 0, 0]);
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
    expect(await rows('SELECT id, enabled, disabled_reason FROM nest_webhooks_endpoints')).toEqual([{ id: gone.id, enabled: 0, disabled_reason: 'gone' }]);
    expect(app.events.filter((event) => event.type === 'endpoint-disabled')).toMatchObject([{ endpointId: gone.id, reason: 'gone' }]);
    expect(await rows('SELECT endpoint_id, failure_reason, last_error FROM nest_webhooks_deliveries ORDER BY failure_reason')).toEqual([
      { endpoint_id: deleted.id, failure_reason: 'endpoint-deleted', last_error: `Endpoint ${deleted.id} was deleted` },
      { endpoint_id: gone.id, failure_reason: 'rejected', last_error: 'WebhookResponseError: Endpoint responded 410' },
    ]);
    expect(await count('nest_webhooks_delivery_attempts')).toBe(1);
    expect(await app.deliveries.stats()).toMatchObject({ failed: 2, pending: 0 });
  });

  it('keeps endpoint secrets sealed in its table as the module hands them over, and signs with them', async () => {
    const receiver = await partner();
    const app = await sender({ encryption: { keys: ['k'.repeat(32)] } });
    const endpoint = await app.endpoints.create({ url: receiver.url('standard'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });

    const [row] = await rows<{ secrets: string }>('SELECT CAST(secrets AS CHAR) AS secrets FROM nest_webhooks_endpoints');
    const secrets = JSON.parse(row!.secrets) as Array<{ secret: string }>;
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.secret).not.toContain(STANDARD_SECRET.slice('whsec_'.length));
    expect(await app.endpoints.getSecret(endpoint.id)).toBe(STANDARD_SECRET);

    await request(app.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
    expect(await app.flush()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.of('standard')).toHaveLength(1);
  });

  it('starts two instances together, which migrate once, and whose workers never deliver a delivery twice', async () => {
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

    // Each instance's outbox publishes its own messages; the fan-outs meet in the store.
    await Promise.all([first.relay.runOnce(), second.relay.runOnce()]);
    expect(await count('nest_webhooks_deliveries')).toBe(12);

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
    expect(await rows('SELECT delivery_id FROM nest_webhooks_delivery_attempts GROUP BY delivery_id HAVING COUNT(*) > 1')).toEqual([]);
    expect(await count('nest_webhooks_delivery_attempts')).toBe(12);
    const delivered = (events: WebhooksEvent[]) => events.filter((event) => event.type === 'delivered').length;
    expect(delivered(first.events) + delivered(second.events)).toBe(12);
  });
});
