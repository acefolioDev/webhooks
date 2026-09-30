/**
 * What MySqlWebhookStore does beyond the contracts. Through every client: keys that differ only in case, accents or a
 * trailing space stay apart and event types compare exactly; text comes back as it went in (NUL, four-byte
 * characters); a key longer than its column is refused before any statement, and the longest that fits is kept; a
 * fan-out to more endpoints than one statement takes parameters for (Prisma prepares on the server: 65,535). Through
 * mysql2: it registers itself, prepares its tables at its first call, takes fractional milliseconds whole, leaves an
 * endpoint that keeps failing unwritten, passes over a delivery another transaction holds, keeps reordered re-fan-outs
 * of one message from deadlocking, and retention works in batches and keeps a message a fan-out is adding to.
 */
import mysql from 'mysql2/promise';
import { WebhooksStorage, type WebhookDelivery, type WebhookEndpointRecord, type WebhookMessage } from '../../lib/index.js';
import { fromMysql2, MySqlWebhookStore } from '../../lib/mysql/index.js';
import { PostgresWebhookStore, type SqlExecutor as PostgresSqlExecutor } from '../../lib/postgres/index.js';
import { clients, mysql2Client, onMysql, tables, testDatabase, truncate, type Client } from './support.js';

const { database, reason } = await testDatabase('mystore_store');

const SCHEMA = 's_store';
const t = tables(SCHEMA);

function endpoint(overrides: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord {
  return {
    id: 'ep_1',
    tenant: 'shop-1',
    url: 'https://hooks.example.com/store',
    eventTypes: ['order.shipped'],
    description: null,
    enabled: true,
    disabledReason: null,
    failingSince: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    secrets: [{ secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', createdAt: 1_000, expiresAt: null }],
    ...overrides,
  };
}

function message(overrides: Partial<WebhookMessage> = {}): WebhookMessage {
  return { id: 'msg_1', type: 'order.shipped', tenant: 'shop-1', body: '{"type":"order.shipped"}', createdAt: 1_000, ...overrides };
}

function delivery(m: WebhookMessage, endpointId: string, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: `dlv_${endpointId}`,
    messageId: m.id,
    endpointId,
    tenant: m.tenant,
    type: m.type,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: m.createdAt,
    lastAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
    failureReason: null,
    createdAt: m.createdAt,
    completedAt: null,
    ...overrides,
  };
}

const succeeded = (at: number) => ({ status: 'succeeded' as const, attempts: 1, nextAttemptAt: null, failureReason: null, completedAt: at });

describe.each(clients)('MySqlWebhookStore through $name', (factory) => {
  let client: Client;
  let store: MySqlWebhookStore;

  beforeAll(async () => {
    if (reason) {
      return;
    }

    client = await factory.open(database!.url);
    await new MySqlWebhookStore({ executor: client.executor, schema: SCHEMA }).migrate();
  });

  afterAll(() => client?.close());

  beforeEach(async (context) => {
    if (reason) {
      context.skip(reason);
    }

    await truncate(client.executor, SCHEMA);
    store = new MySqlWebhookStore({ executor: client.executor, schema: SCHEMA, migrate: false });
  });

  it('keeps keys that differ only in case, accents or a trailing space apart, and compares event types exactly', async () => {
    const keys = ['ep_a', 'ep_A', 'ep_á', 'ep_a '];
    const tenants = ['shop', 'Shop', 'shöp', 'shop '];
    for (const [i, id] of keys.entries()) {
      await store.createEndpoint(endpoint({ id, tenant: tenants[i]!, createdAt: i, eventTypes: i === 0 ? ['order.shipped'] : ['Order.Shipped', 'ordér.shipped', 'order.shipped '] }));
    }
    for (const [i, id] of keys.entries()) {
      expect(await store.getEndpoint(id)).toMatchObject({ id, tenant: tenants[i] });
    }
    expect(await store.getEndpoint('EP_A')).toBeUndefined();
    expect((await store.listEndpoints({ tenant: 'shop' })).map((e) => e.id)).toEqual(['ep_a']);
    expect((await store.findSubscribedEndpoints('shop', 'order.shipped')).map((e) => e.id)).toEqual(['ep_a']);
    expect(await store.findSubscribedEndpoints('Shop', 'order.shipped')).toEqual([]);
    expect((await store.findSubscribedEndpoints('Shop', 'Order.Shipped')).map((e) => e.id)).toEqual(['ep_A']);

    // A fan-out to endpoints whose ids differ only in case: two deliveries, not one.
    const m = message({ tenant: 'shop' });
    expect(await store.createDeliveries(m, keys.map((id) => delivery(m, id)))).toBe(4);
    expect(await store.createDeliveries(m, keys.map((id) => delivery(m, id, { id: `dlv_again_${id}` })))).toBe(0);
    expect((await store.listDeliveries({ endpointId: 'ep_A' })).map((d) => d.endpointId)).toEqual(['ep_A']);
    expect(await store.listDeliveries({ type: 'Order.Shipped' })).toEqual([]);
    expect(await store.listDeliveries({ tenant: 'Shop' })).toEqual([]);

    // The lease's owner, too: W1 isn't w1.
    const [claimed] = await store.claimDeliveries({ owner: 'w1', now: 1_000, leaseMs: 100, limit: 1 });
    const first = claimed!.delivery;
    expect(await store.recordDeliveryAttempt(first.id, 'W1', succeeded(1_001))).toBe(false);
    expect(await store.releaseDeliveries([first.id], 'W1')).toBe(0);
    expect(await store.recordDeliveryAttempt(first.id, 'w1', succeeded(1_001))).toBe(true);
  });

  it('keeps text as it came: NUL, four-byte characters and non-ASCII in a body, a response, an error, a description and secrets', async () => {
    const text = 'Łódź 😀 \u0000   "q" \\';
    await store.createEndpoint(endpoint({ description: text, secrets: [{ secret: `whsec_${text}`, createdAt: 1, expiresAt: null }] }));
    expect(await store.getEndpoint('ep_1')).toMatchObject({ description: text, secrets: [{ secret: `whsec_${text}`, createdAt: 1, expiresAt: null }] });

    const m = message({ body: `{"data":"${text}"}` });
    await store.createDeliveries(m, [delivery(m, 'ep_1')]);
    expect(await store.getMessage(m.id)).toEqual(m);
    await store.claimDeliveries({ owner: 'w1', now: 1_000, leaseMs: 100, limit: 1 });
    // A response cut by the size limit in the middle of an emoji: the lone surrogate can't be encoded, and the driver
    // sends U+FFFD for it.
    const response = `PK\u0003\u0004\u0000 ${text} 😀`.slice(0, -1);
    const attempt = { deliveryId: 'dlv_ep_1', attempt: 1, at: 1_000, durationMs: 5, statusCode: 500, response, error: `Endpoint responded 500: ${text}` };
    expect(await store.recordDeliveryAttempt('dlv_ep_1', 'w1', { status: 'pending', attempts: 1, nextAttemptAt: 2_000, failureReason: null, completedAt: null, attempt })).toBe(true);
    expect(await store.listDeliveryAttempts('dlv_ep_1')).toEqual([{ ...attempt, response: `${response.slice(0, -1)}�` }]);
    expect((await store.getDelivery('dlv_ep_1'))!.lastError).toBe(`Endpoint responded 500: ${text}`);
  });

  it('refuses a key longer than its column before any statement, and keeps the longest that fits, in four-byte characters too', async () => {
    const emoji = (n: number) => '😀'.repeat(n);
    await expect(store.createEndpoint(endpoint({ id: 'e'.repeat(256) }))).rejects.toThrow(
      new RangeError("MySqlWebhookStore: an endpoint's id is at most 255 characters on MySQL (a key column), and this one has 256."),
    );
    await expect(store.createEndpoint(endpoint({ tenant: emoji(257) }))).rejects.toThrow("an endpoint's tenant is at most 256 characters on MySQL (a key column), and this one has 257.");
    const m = message();
    await expect(store.createDeliveries(m, [delivery(m, 'e'.repeat(300), { id: 'dlv_1' })])).rejects.toThrow("a delivery's endpoint id is at most 255 characters");
    await expect(store.createDeliveries(message({ id: 'm'.repeat(256) }), [])).rejects.toThrow("a message's id is at most 255 characters");
    await expect(store.claimDeliveries({ owner: 'o'.repeat(256), now: 1, leaseMs: 1, limit: 1 })).rejects.toThrow("a lease's owner is at most 255 characters");
    expect(await store.listEndpoints({})).toEqual([]);

    // 255 four-byte characters of id and 256 of tenant: 2,052 bytes of the tenant index's 3,072.
    const longest = endpoint({ id: emoji(255), tenant: emoji(256) });
    await store.createEndpoint(longest);
    expect(await store.getEndpoint(longest.id)).toEqual(longest);
    expect((await store.listEndpoints({ tenant: longest.tenant })).map((e) => e.id)).toEqual([longest.id]);
    const n = message({ id: emoji(255), tenant: emoji(256) });
    expect(await store.createDeliveries(n, [delivery(n, emoji(255), { id: emoji(255) })])).toBe(1);
    const [claimed] = await store.claimDeliveries({ owner: emoji(255), now: 1_000, leaseMs: 100, limit: 1 });
    expect(claimed).toMatchObject({ delivery: { id: emoji(255), endpointId: emoji(255), tenant: emoji(256) }, message: n });
    expect(await store.recordDeliveryAttempt(emoji(255), emoji(255), succeeded(1_001))).toBe(true);
  });

  it('creates one delivery for an endpoint a fan-out lists twice: the first in endpoint and id order, as a unique key keeps it', async () => {
    const m = message();
    expect(await store.createDeliveries(m, [delivery(m, 'ep_1', { id: 'dlv_b' }), delivery(m, 'ep_2'), delivery(m, 'ep_1', { id: 'dlv_a' })])).toBe(2);
    expect((await store.listDeliveries({ messageId: m.id })).map((d) => d.id).sort()).toEqual(['dlv_a', 'dlv_ep_2']);
  });

  it('fans a message out to more endpoints than one statement takes parameters for, once', async () => {
    const m = message();
    const endpoints = Array.from({ length: 5_000 }, (_, i) => `ep_${String(i).padStart(4, '0')}`);
    expect(await store.createDeliveries(m, endpoints.map((e) => delivery(m, e)))).toBe(5_000);
    expect(await store.createDeliveries(m, endpoints.map((e) => delivery(m, e, { id: `dlv_again_${e}` })))).toBe(0);
    expect(await store.listDeliveries({ messageId: m.id, limit: 6_000 })).toHaveLength(5_000);
  });
});

describe('MySqlWebhookStore through mysql2', () => {
  let client: Client;
  let store: MySqlWebhookStore;

  beforeAll(async () => {
    if (reason) {
      return;
    }

    client = await mysql2Client.open(database!.url);
    await new MySqlWebhookStore({ executor: client.executor, schema: SCHEMA }).migrate();
  });

  afterAll(() => client?.close());

  beforeEach(async (context) => {
    if (reason) {
      context.skip(reason);
    }

    await truncate(client.executor, SCHEMA);
    store = new MySqlWebhookStore({ executor: client.executor, schema: SCHEMA, migrate: false });
  });

  const rows = async (sql: string, params: unknown[] = []) => (await database!.admin.query(sql, params))[0] as Array<Record<string, unknown>>;

  it('registers itself for both contracts when given the registry', () => {
    const storage = new WebhooksStorage();
    const registered = new MySqlWebhookStore({ executor: client.executor, schema: SCHEMA }, storage);
    expect(storage.endpoints).toBe(registered);
    expect(storage.deliveries).toBe(registered);
  });

  it('prepares its tables at its first call outside Nest, and serves', async () => {
    const fresh = new MySqlWebhookStore({ executor: client.executor, schema: 's_first_call' });
    expect(await fresh.listEndpoints({})).toEqual([]);
    expect(await rows('SELECT version FROM s_first_call_migrations')).toEqual([{ version: 1 }]);
  });

  it('is refused by the PostgreSQL store, which names its own subpath', () => {
    expect(() => new PostgresWebhookStore({ executor: client.executor as unknown as PostgresSqlExecutor })).toThrow(
      "PostgresWebhookStore runs on PostgreSQL, and `executor` is a MySQL executor: import the executor from '@nestjs/webhooks/postgres' (fromPg, fromDrizzle, fromTypeOrm, fromPrisma or fromKysely).",
    );
  });

  it('takes fractional milliseconds (a fractional duration in the options), whole, as a Date would', async () => {
    await store.createEndpoint(endpoint({ failingSince: 999.5, createdAt: 1_000.7, updatedAt: 1_000.7 }));
    expect(await store.getEndpoint('ep_1')).toMatchObject({ failingSince: 999, createdAt: 1_000, updatedAt: 1_000 });
    expect(await store.updateEndpoint('ep_1', { failingSince: 5.5 }, 1_100.9)).toMatchObject({ failingSince: 5, updatedAt: 1_100 });
    expect(await store.recordEndpointFailure('ep_1', { at: 1_200.5, disableIfFailingSince: 10.5, reason: 'failing' })).toBe(true);
    expect(await store.getEndpoint('ep_1')).toMatchObject({ enabled: false, updatedAt: 1_200 });

    const m = message({ createdAt: 1_000.9 });
    const d = delivery(m, 'ep_1');
    expect(await store.createDeliveries(m, [d])).toBe(1);
    expect(await store.claimDeliveries({ owner: 'w1', now: 1_001.5, leaseMs: 99.9, limit: 1 })).toHaveLength(1);
    const retry = { status: 'pending' as const, attempts: 1, nextAttemptAt: 1_500.5, failureReason: null, completedAt: null };
    const attempt = { deliveryId: d.id, attempt: 1, at: 1_001.5, durationMs: 12.7, statusCode: 503, response: null, error: 'Endpoint responded 503' };
    expect(await store.recordDeliveryAttempt(d.id, 'w1', { ...retry, attempt })).toBe(true);
    expect(await store.getDelivery(d.id)).toMatchObject({ nextAttemptAt: 1_500, lastAttemptAt: 1_001, createdAt: 1_000 });
    expect(await store.listDeliveryAttempts(d.id)).toMatchObject([{ at: 1_001, durationMs: 12 }]);

    expect(await store.claimDeliveries({ owner: 'w2', now: 1_500.7, leaseMs: 10.5, limit: 1 })).toHaveLength(1);
    expect(await store.releaseDeliveries([d.id], 'w2', 1_800.8)).toBe(1);
    expect(await store.deliveryStats(1_900.1)).toEqual({ pending: 1, due: 1, leased: 0, failed: 0, oldestDueAt: 1_800 });
    expect(await store.retryDeliveries({ since: 999.5 }, 2_000.5)).toBe(1);
    await store.claimDeliveries({ owner: 'w3', now: 2_000.5, leaseMs: 10, limit: 1 });
    await store.recordDeliveryAttempt(d.id, 'w3', { ...succeeded(2_100.2), attempt: { ...attempt, at: 2_000.5 } });
    // Both 2_100 once whole, as two Dates would be: not before it.
    expect(await store.pruneDeliveries(2_100.9)).toBe(0);
    expect(await store.pruneDeliveries(2_101.5)).toBe(1);
  });

  it('leaves an endpoint that keeps failing unwritten, secrets and all, until a failure disables it', async () => {
    await rows('CREATE TABLE IF NOT EXISTS endpoint_writes (seq int NOT NULL AUTO_INCREMENT PRIMARY KEY, id varchar(255) NOT NULL)');
    await rows('DROP TRIGGER IF EXISTS count_endpoint_writes');
    await rows(`CREATE TRIGGER count_endpoint_writes AFTER UPDATE ON ${t.endpoints} FOR EACH ROW INSERT INTO endpoint_writes (id) VALUES (NEW.id)`);
    try {
      await store.createEndpoint(endpoint());
      const writes = async () => (await rows('SELECT COUNT(*) AS n FROM endpoint_writes'))[0]!.n;

      expect(await store.recordEndpointFailure('ep_1', { at: 100, disableIfFailingSince: 50, reason: 'failing' })).toBe(false);
      expect(await writes()).toBe(1);
      expect(await store.recordEndpointFailure('ep_1', { at: 200, disableIfFailingSince: 50, reason: 'failing' })).toBe(false);
      expect(await store.recordEndpointFailure('ep_1', { at: 300, disableIfFailingSince: null, reason: 'failing' })).toBe(false);
      expect(await writes()).toBe(1);

      expect(await store.recordEndpointFailure('ep_1', { at: 400, disableIfFailingSince: 100, reason: 'failing' })).toBe(true);
      expect(await writes()).toBe(2);
      expect(await store.getEndpoint('ep_1')).toMatchObject({ enabled: false, disabledReason: 'failing', failingSince: 100, updatedAt: 400 });
    } finally {
      await rows('DROP TRIGGER IF EXISTS count_endpoint_writes');
    }
  });

  it('passes over a delivery another transaction holds, without waiting for it', async () => {
    const m = message();
    const [held, free] = [delivery(m, 'ep_a', { nextAttemptAt: 1 }), delivery(m, 'ep_b', { nextAttemptAt: 2 })];
    await store.createDeliveries(m, [held, free]);

    const holder = await database!.admin.getConnection();
    try {
      await holder.beginTransaction();
      await holder.query(`SELECT id FROM ${t.deliveries} WHERE id = ? FOR UPDATE`, [held.id]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the claim waited for the delivery another transaction holds')), 5_000);
      });
      const claimed = await Promise.race([store.claimDeliveries({ owner: 'w1', now: 10, leaseMs: 1_000, limit: 10 }), waited]).finally(() => clearTimeout(timer));
      expect(claimed.map((c) => c.delivery.id)).toEqual([free.id]);
    } finally {
      await holder.rollback();
      holder.release();
    }

    expect((await store.claimDeliveries({ owner: 'w2', now: 10, leaseMs: 1_000, limit: 10 })).map((c) => c.delivery.id)).toEqual([held.id]);
  });

  it('fans a message out again from four processes at once, whatever order each lists its endpoints in: they take turns on its row', async () => {
    const m = message();
    const endpoints = Array.from({ length: 1_000 }, (_, i) => `ep_${String(i).padStart(4, '0')}`);
    const evens = endpoints.filter((_, i) => i % 2 === 0);
    const odds = endpoints.filter((_, i) => i % 2 === 1);
    const orders = [endpoints, endpoints.toReversed(), [...evens, ...odds], [...odds.toReversed(), ...evens.toReversed()]];

    // The message is in already (a relay publishing it again), so the four meet on its row, not on its insert.
    await store.createDeliveries(m, []);
    await Promise.all(Array.from({ length: 4 }, () => store.getDelivery('dlv_missing')));
    const counts = await Promise.all(orders.map((order, i) => store.createDeliveries(m, order.map((e) => delivery(m, e, { id: `dlv_${i}_${e}` })))));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1_000);
    expect(await store.listDeliveries({ messageId: m.id, limit: 2_000 })).toHaveLength(1_000);
  });

  it('prunes in batches: finished deliveries with their attempts, and messages left without deliveries, never a pending one', async () => {
    // 1,200 messages of one finished delivery each, with its attempt (two batches of each), and one message that has
    // a pending delivery too. Written directly: the store would take a transaction per message.
    const ids = Array.from({ length: 1_200 }, (_, i) => String(i).padStart(4, '0'));
    await rows(`INSERT INTO ${t.messages} (id, type, tenant, body, created_at) VALUES ${ids.map((i) => `('msg_${i}', 't', NULL, '{}', 1)`).join(', ')}`);
    await rows(
      `INSERT INTO ${t.deliveries} (id, message_id, endpoint_id, tenant, type, status, attempts, next_attempt_at, created_at, completed_at) VALUES ` +
        `${ids.map((i) => `('dlv_${i}', 'msg_${i}', 'ep_1', NULL, 't', 'succeeded', 1, NULL, 1, 20)`).join(', ')}, ('dlv_pending', 'msg_0007', 'ep_2', NULL, 't', 'pending', 0, 5, 1, NULL)`,
    );
    await rows(`INSERT INTO ${t.attempts} (delivery_id, attempt, at, duration_ms, status_code) VALUES ${ids.map((i) => `('dlv_${i}', 1, 10, 1, 200)`).join(', ')}`);

    expect(await store.pruneDeliveries(20)).toBe(0);
    expect(await store.pruneDeliveries(21)).toBe(1_200);
    expect(await rows(`SELECT COUNT(*) AS n FROM ${t.attempts}`)).toEqual([{ n: 0 }]);
    expect(await rows(`SELECT id FROM ${t.messages}`)).toEqual([{ id: 'msg_0007' }]);
    expect((await store.listDeliveries({})).map((d) => d.id)).toEqual(['dlv_pending']);
  });

  it("keeps a message a fan-out is adding deliveries to while retention looks for messages left without any", async () => {
    // A message without deliveries (a fan-out that found no endpoint), which a fan-out running again now adds one to.
    const m = message();
    await store.createDeliveries(m, []);
    const d = delivery(m, 'ep_1');
    const holder = await database!.admin.getConnection();
    try {
      await holder.beginTransaction();
      await holder.query(`INSERT INTO ${t.messages} (id, type, tenant, body, created_at) VALUES (?, 'x', NULL, '{}', 1) ON DUPLICATE KEY UPDATE id = id`, [m.id]);
      await holder.query(
        `INSERT INTO ${t.deliveries} (id, message_id, endpoint_id, tenant, type, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, 1000, 1000)`,
        [d.id, m.id, d.endpointId, m.tenant, m.type],
      );

      let settled = false;
      const pruning = store.pruneDeliveries(1_000_000).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await holder.commit();
      expect(await pruning).toBe(0);
    } finally {
      holder.release();
    }

    expect(await store.getMessage(m.id)).toEqual(m);
    expect(await store.getDelivery(d.id)).toMatchObject({ id: d.id, messageId: m.id, status: 'pending' });
    // Without deliveries again, it goes.
    await rows(`DELETE FROM ${t.deliveries}`);
    expect(await store.pruneDeliveries(1_000_000)).toBe(0);
    expect(await store.getMessage(m.id)).toBeUndefined();
  });

});

describe('MySqlWebhookStore on a pool of one connection', () => {
  onMysql(reason);

  it('takes turns on it: its transactions and statements never wait for each other forever', async () => {
    const single = mysql.createPool({ uri: database!.url, connectionLimit: 1 });
    try {
      const one = new MySqlWebhookStore({ executor: fromMysql2(single), schema: 's_single' });
      const m = message();
      await Promise.all([one.createEndpoint(endpoint()), one.createDeliveries(m, [delivery(m, 'ep_1'), delivery(m, 'ep_2')])]);
      const [a, b] = await Promise.all([
        one.claimDeliveries({ owner: 'w1', now: 1_000, leaseMs: 100, limit: 1 }),
        one.claimDeliveries({ owner: 'w2', now: 1_000, leaseMs: 100, limit: 1 }),
      ]);
      expect([...a, ...b].map((c) => c.delivery.id).sort()).toEqual(['dlv_ep_1', 'dlv_ep_2']);
      expect(await Promise.all([one.addEndpointSecret('ep_1', { secret: 'whsec_2', createdAt: 2, expiresAt: null }, 10, 2), one.deliveryStats(1_000)])).toEqual([
        true,
        { pending: 2, due: 0, leased: 2, failed: 0, oldestDueAt: 1_000 },
      ]);
    } finally {
      await single.end();
    }
  });
});
