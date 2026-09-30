/**
 * What PostgresWebhookStore does beyond the contracts, on PGlite and on PostgreSQL: it registers itself, prepares its
 * schema at its first call outside Nest, keeps what PostgreSQL would refuse (NUL in a response, fractional
 * milliseconds) instead of failing the worker's writes, fans out to more endpoints than one statement takes, keeps
 * concurrent rotations and fan-outs whole, passes over deliveries another transaction holds, and leaves an endpoint that
 * keeps failing unwritten until it disables it.
 */
import { WebhooksStorage, type WebhookDelivery, type WebhookEndpointRecord, type WebhookMessage } from '../../lib/index.js';
import { PostgresWebhookStore } from '../../lib/postgres/index.js';
import { openPglite, pgClient, testDatabase, truncate, type Client } from './support.js';

const { database, reason } = await testDatabase('pgstore_store');

const SCHEMA = 's_store';

const targets = [
  { name: 'on PGlite', open: openPglite, postgres: false, skip: undefined },
  { name: 'on PostgreSQL', open: () => pgClient.open(database!.url), postgres: true, skip: reason },
];

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

describe.each(targets)('PostgresWebhookStore $name', ({ open, postgres, skip }) => {
  let client: Client;
  let store: PostgresWebhookStore;

  beforeAll(async () => {
    if (skip) {
      return;
    }

    client = await open();
    await new PostgresWebhookStore({ executor: client.executor, schema: SCHEMA }).migrate();
  });

  afterAll(() => client?.close());

  beforeEach(async (context) => {
    if (skip) {
      context.skip(skip);
    }

    await truncate(client.executor, SCHEMA);
    store = new PostgresWebhookStore({ executor: client.executor, schema: SCHEMA, migrate: false });
  });

  it('registers itself for both contracts when given the registry', () => {
    const storage = new WebhooksStorage();
    const registered = new PostgresWebhookStore({ executor: client.executor, schema: SCHEMA }, storage);
    expect(storage.endpoints).toBe(registered);
    expect(storage.deliveries).toBe(registered);
  });

  it('prepares its schema at its first call outside Nest, and serves', async () => {
    const fresh = new PostgresWebhookStore({ executor: client.executor, schema: 's_first_call' });
    expect(await fresh.listEndpoints({})).toEqual([]);
    expect(await client.executor.query('SELECT version FROM s_first_call.migrations')).toEqual([{ version: 1 }]);
  });

  it("records a response and an error that hold NUL, as U+FFFD, instead of failing the worker's write", async () => {
    const m = message();
    const d = delivery(m, 'ep_1');
    await store.createDeliveries(m, [d]);
    await store.claimDeliveries({ owner: 'w1', now: 1_000, leaseMs: 100, limit: 1 });

    const recorded = await store.recordDeliveryAttempt(d.id, 'w1', {
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 2_000,
      failureReason: null,
      completedAt: null,
      // A binary body, cut by the response size limit in the middle of an emoji.
      attempt: { deliveryId: d.id, attempt: 1, at: 1_000, durationMs: 5, statusCode: 500, response: 'PK\u0003\u0004\u0000\u0000 😀'.slice(0, 8), error: 'Endpoint responded 500\u0000' },
    });
    expect(recorded).toBe(true);
    expect(await store.listDeliveryAttempts(d.id)).toEqual([
      { deliveryId: d.id, attempt: 1, at: 1_000, durationMs: 5, statusCode: 500, response: 'PK\u0003\u0004\uFFFD\uFFFD \uFFFD', error: 'Endpoint responded 500\uFFFD' },
    ]);
    expect((await store.getDelivery(d.id))!.lastError).toBe('Endpoint responded 500\uFFFD');

    await store.claimDeliveries({ owner: 'w2', now: 2_000, leaseMs: 100, limit: 1 });
    const failed = { status: 'failed' as const, attempts: 1, nextAttemptAt: null, failureReason: 'endpoint-deleted' as const, completedAt: 2_000 };
    expect(await store.recordDeliveryAttempt(d.id, 'w2', { ...failed, error: 'Endpoint ep_1\u0000 was deleted' })).toBe(true);
    expect((await store.getDelivery(d.id))!.lastError).toBe('Endpoint ep_1\uFFFD was deleted');
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
    await store.recordDeliveryAttempt(d.id, 'w3', { status: 'succeeded', attempts: 1, nextAttemptAt: null, failureReason: null, completedAt: 2_100.2, attempt: { ...attempt, at: 2_000.5 } });
    // Both 2_100 once whole, as two Dates would be: not before it.
    expect(await store.pruneDeliveries(2_100.9)).toBe(0);
    expect(await store.pruneDeliveries(2_101.5)).toBe(1);
  });

  it('fans a message out to more endpoints than one statement takes parameters for, once', async () => {
    const m = message();
    const endpoints = Array.from({ length: 5_000 }, (_, i) => `ep_${String(i).padStart(4, '0')}`);
    expect(await store.createDeliveries(m, endpoints.map((e) => delivery(m, e)))).toBe(5_000);
    expect(await store.createDeliveries(m, endpoints.map((e) => delivery(m, e, { id: `dlv_again_${e}` })))).toBe(0);
    expect(await store.listDeliveries({ messageId: m.id, limit: 6_000 })).toHaveLength(5_000);
  });

  it("leaves an endpoint that keeps failing unwritten, secrets and all, until a failure disables it", async () => {
    await store.createEndpoint(endpoint());
    const version = async () => (await client.executor.query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM ${SCHEMA}.endpoints WHERE id = 'ep_1'`))[0]!.xmin;

    expect(await store.recordEndpointFailure('ep_1', { at: 100, disableIfFailingSince: 50, reason: 'failing' })).toBe(false);
    const failing = await version();
    expect(await store.recordEndpointFailure('ep_1', { at: 200, disableIfFailingSince: 50, reason: 'failing' })).toBe(false);
    expect(await store.recordEndpointFailure('ep_1', { at: 300, disableIfFailingSince: null, reason: 'failing' })).toBe(false);
    expect(await version()).toBe(failing);

    expect(await store.recordEndpointFailure('ep_1', { at: 400, disableIfFailingSince: 100, reason: 'failing' })).toBe(true);
    expect(await version()).not.toBe(failing);
    expect(await store.getEndpoint('ep_1')).toMatchObject({ enabled: false, disabledReason: 'failing', failingSince: 100, updatedAt: 400 });
  });

  it.runIf(postgres)('lands every one of ten rotations at once: each reads the secrets of those before it', async () => {
    await store.createEndpoint(endpoint({ secrets: [{ secret: 'whsec_0', createdAt: 0, expiresAt: null }] }));
    // A connection each, open already, so the rotations overlap instead of queueing for connections.
    await Promise.all(Array.from({ length: 10 }, () => client.executor.query('SELECT pg_sleep(0.05)::text')));

    const rotated = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.addEndpointSecret('ep_1', { secret: `whsec_${i + 1}`, createdAt: i + 1, expiresAt: null }, 1_000_000, 1)),
    );
    expect(rotated).toEqual(Array(10).fill(true));
    const { secrets } = (await store.getEndpoint('ep_1'))!;
    expect(secrets.map((s) => s.secret).sort()).toEqual(Array.from({ length: 11 }, (_, i) => `whsec_${i}`).sort());
    expect(secrets.filter((s) => s.expiresAt === null)).toHaveLength(1);
  });

  it.runIf(postgres)('fans one message out again from four processes at once, whatever order each lists its endpoints in', async () => {
    const m = message();
    const endpoints = Array.from({ length: 1_000 }, (_, i) => `ep_${String(i).padStart(4, '0')}`);
    const evens = endpoints.filter((_, i) => i % 2 === 0);
    const odds = endpoints.filter((_, i) => i % 2 === 1);
    const orders = [endpoints, endpoints.toReversed(), [...evens, ...odds], [...odds.toReversed(), ...evens.toReversed()]];

    // The message is in already, so the four don't queue behind its insert: they race on the deliveries, and in
    // orders of their own each would wait for a row another inserted, and deadlock.
    await store.createDeliveries(m, []);
    await Promise.all(Array.from({ length: 4 }, () => client.executor.query('SELECT pg_sleep(0.05)::text')));
    const counts = await Promise.all(orders.map((order, i) => store.createDeliveries(m, order.map((e) => delivery(m, e, { id: `dlv_${i}_${e}` })))));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1_000);
    expect(await store.listDeliveries({ messageId: m.id, limit: 2_000 })).toHaveLength(1_000);
  });

  it.runIf(postgres)('passes over a delivery another transaction holds, without waiting for it', async () => {
    const m = message();
    const [held, free] = [delivery(m, 'ep_a', { nextAttemptAt: 1 }), delivery(m, 'ep_b', { nextAttemptAt: 2 })];
    await store.createDeliveries(m, [held, free]);

    const holder = await database!.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM ${SCHEMA}.deliveries WHERE id = $1 FOR UPDATE`, [held.id]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the claim waited for the delivery another transaction holds')), 5_000);
      });
      const claimed = await Promise.race([store.claimDeliveries({ owner: 'w1', now: 10, leaseMs: 1_000, limit: 10 }), waited]).finally(() => clearTimeout(timer));
      expect(claimed.map((c) => c.delivery.id)).toEqual([free.id]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    expect((await store.claimDeliveries({ owner: 'w2', now: 10, leaseMs: 1_000, limit: 10 })).map((c) => c.delivery.id)).toEqual([held.id]);
  });
});
