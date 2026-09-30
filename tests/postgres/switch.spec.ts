/**
 * Switching from the hand-written store the docs used to show (tests/fixtures/database/drizzle-webhook.store.ts, on
 * the tutorial's drizzle-kit migrations) to PostgresWebhookStore: the rows it wrote, copied with the SQL the docs give,
 * read the same through the new store, which takes over the pending deliveries. On PGlite and on PostgreSQL.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { WebhooksStorage, type WebhookDelivery, type WebhookDeliveryStore, type WebhookEndpointStore, type WebhookMessage } from '../../lib/index.js';
import { fromDrizzle, PostgresWebhookStore } from '../../lib/postgres/index.js';
import { DrizzleWebhookStore } from '../fixtures/database/drizzle-webhook.store.js';
import type { Database } from '../fixtures/database/drizzle.js';
import { endPool } from '../support/postgres.js';
import { testDatabase } from './support.js';

const migrationsFolder = fileURLToPath(new URL('../fixtures/drizzle', import.meta.url));

const { database: server, reason } = await testDatabase('pgstore_switch');

/**
 * The docs' copy, once PostgresWebhookStore's schema is migrated and the hand-written store's workers have stopped:
 * epoch milliseconds for timestamps, a JSON array for event types; leases stay behind.
 */
const COPY_FROM_HAND_WRITTEN_STORE = `
BEGIN;

INSERT INTO nest_webhooks.endpoints (id, tenant, url, event_types, description, enabled, disabled_reason, failing_since, secrets, created_at, updated_at)
SELECT id, tenant, url, to_jsonb(event_types), description, enabled, disabled_reason, (extract(epoch FROM failing_since) * 1000)::bigint, secrets,
  (extract(epoch FROM created_at) * 1000)::bigint, (extract(epoch FROM updated_at) * 1000)::bigint
FROM webhook_endpoints;

INSERT INTO nest_webhooks.messages (id, type, tenant, body, created_at)
SELECT id, type, tenant, body, (extract(epoch FROM created_at) * 1000)::bigint
FROM webhook_messages;

INSERT INTO nest_webhooks.deliveries (id, message_id, endpoint_id, tenant, type, status, attempts, next_attempt_at, last_attempt_at, last_status_code,
  last_error, failure_reason, created_at, completed_at)
SELECT id, message_id, endpoint_id, tenant, type, status, attempts, (extract(epoch FROM next_attempt_at) * 1000)::bigint,
  (extract(epoch FROM last_attempt_at) * 1000)::bigint, last_status_code, last_error, failure_reason, (extract(epoch FROM created_at) * 1000)::bigint,
  (extract(epoch FROM completed_at) * 1000)::bigint
FROM webhook_deliveries;

INSERT INTO nest_webhooks.delivery_attempts (delivery_id, attempt, at, duration_ms, status_code, response, error)
SELECT delivery_id, attempt, (extract(epoch FROM at) * 1000)::bigint, duration_ms, status_code, response, error
FROM webhook_delivery_attempts
ORDER BY seq;

COMMIT;
`;

const T = 1_790_000_000_123;

const byId = <T extends { id: string }>(items: T[]) => items.toSorted((a, b) => (a.id < b.id ? -1 : 1));

const targets = [
  { label: 'PGlite', skip: undefined },
  { label: 'PostgreSQL', skip: reason },
];

describe.each(targets)('switching from the hand-written Drizzle store, on $label', ({ label, skip }) => {
  let db: Database;
  let exec: (statement: string) => Promise<unknown>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (skip) {
      return;
    }

    if (label === 'PGlite') {
      const pglite = new PGlite();
      const database = drizzlePglite(pglite);
      await migratePglite(database, { migrationsFolder });
      db = database as unknown as Database;
      exec = (statement) => pglite.exec(statement);
      close = () => pglite.close();
    } else {
      const pool = new pg.Pool({ connectionString: server!.url, max: 4 });
      db = drizzle(pool) as Database;
      await migrate(db, { migrationsFolder });
      exec = (statement) => pool.query(statement);
      close = () => endPool(pool);
    }
  });

  afterAll(() => close?.());

  beforeEach((context) => {
    if (skip) {
      context.skip(skip);
    }
  });

  /** Everything a store gives back, as the package reads it. */
  async function snapshot(store: WebhookEndpointStore & WebhookDeliveryStore, messageIds: string[]) {
    const deliveries = await store.listDeliveries({ limit: 100 });
    return {
      endpoints: await store.listEndpoints({ limit: 100 }),
      // The fan-out's query promises no order.
      subscribed: byId(await store.findSubscribedEndpoints('shop-1', 'order.shipped')),
      untenanted: byId(await store.findSubscribedEndpoints(null, 'order.cancelled')),
      messages: await Promise.all(messageIds.map((id) => store.getMessage(id))),
      deliveries,
      attempts: await Promise.all(deliveries.map((delivery) => store.listDeliveryAttempts(delivery.id))),
      stats: await store.deliveryStats(T + 60_000),
    };
  }

  it("reads what the hand-written store wrote the same after the docs' copy, and takes over its pending deliveries", async () => {
    const before = new DrizzleWebhookStore(db, new WebhooksStorage());
    const secret = (n: number) => ({ secret: `whsec_${String(n).repeat(32)}`, createdAt: T + n, expiresAt: null });
    const endpoint = (id: string, tenant: string | null, eventTypes: string[]) => ({
      id,
      tenant,
      url: `https://${id}.example.com/hooks?token=a%20b`,
      eventTypes,
      description: tenant ? `${tenant}'s endpoint (Kätzchen & Kibble)` : null,
      enabled: true,
      disabledReason: null,
      failingSince: null,
      createdAt: T,
      updatedAt: T,
      secrets: [secret(1)],
    });
    await before.createEndpoint(endpoint('ep_a', 'shop-1', ['order.shipped', 'order.cancelled']));
    await before.createEndpoint(endpoint('ep_b', 'shop-1', ['*']));
    await before.createEndpoint(endpoint('ep_c', null, ['order.cancelled']));
    await before.addEndpointSecret('ep_a', secret(2), T + 86_400_000, T + 2);
    await before.recordEndpointFailure('ep_b', { at: T + 5, disableIfFailingSince: null, reason: 'failing' });
    await before.updateEndpoint('ep_c', { enabled: false, disabledReason: 'manual' }, T + 7);

    const message = (id: string, type: string, tenant: string | null): WebhookMessage => ({
      id,
      type,
      tenant,
      body: `{"type":"${type}","timestamp":"2026-09-21T12:53:20.123Z","data":{"orderId":"o-1","note":"Łódź \\u2028"}}`,
      createdAt: T + 10,
    });
    const delivery = (m: WebhookMessage, endpointId: string): WebhookDelivery => ({
      id: `dlv_${m.id}_${endpointId}`,
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
    });
    const shipped = message('msg_1', 'order.shipped', 'shop-1');
    const cancelled = message('msg_2', 'order.cancelled', null);
    await before.createDeliveries(shipped, [delivery(shipped, 'ep_a'), delivery(shipped, 'ep_b')]);
    await before.createDeliveries(cancelled, [delivery(cancelled, 'ep_c')]);

    // One succeeds, one fails for good, one is retried later.
    await before.claimDeliveries({ owner: 'w1', now: T + 20, leaseMs: 30_000, limit: 10 });
    const attempt = (deliveryId: string, statusCode: number) => ({
      deliveryId,
      attempt: 1,
      at: T + 21,
      durationMs: 42,
      statusCode,
      response: statusCode < 300 ? 'ok' : 'upstream said "no" ü',
      error: statusCode < 300 ? null : `Endpoint responded ${statusCode}`,
    });
    await before.recordDeliveryAttempt('dlv_msg_1_ep_a', 'w1', {
      status: 'succeeded',
      attempts: 1,
      nextAttemptAt: null,
      failureReason: null,
      completedAt: T + 22,
      attempt: attempt('dlv_msg_1_ep_a', 204),
    });
    await before.recordDeliveryAttempt('dlv_msg_1_ep_b', 'w1', {
      status: 'pending',
      attempts: 1,
      nextAttemptAt: T + 5_000,
      failureReason: null,
      completedAt: null,
      attempt: attempt('dlv_msg_1_ep_b', 503),
    });
    await before.recordDeliveryAttempt('dlv_msg_2_ep_c', 'w1', {
      status: 'failed',
      attempts: 0,
      nextAttemptAt: null,
      failureReason: 'endpoint-disabled',
      completedAt: T + 23,
      error: 'Endpoint ep_c is disabled (manual)',
    });

    const after = new PostgresWebhookStore({ executor: fromDrizzle(db) });
    await after.migrate();
    await exec(COPY_FROM_HAND_WRITTEN_STORE);

    const copied = await snapshot(after, ['msg_1', 'msg_2']);
    expect(copied).toEqual(await snapshot(before, ['msg_1', 'msg_2']));
    expect(copied.endpoints.find((e) => e.id === 'ep_a')!.secrets).toEqual([secret(2), { ...secret(1), expiresAt: T + 86_400_000 }]);
    expect(copied.stats).toEqual({ pending: 1, due: 1, leased: 0, failed: 1, oldestDueAt: T + 5_000 });

    const claimed = await after.claimDeliveries({ owner: 'w2', now: T + 5_000, leaseMs: 30_000, limit: 10 });
    expect(claimed.map((c) => [c.delivery.id, c.message.body])).toEqual([['dlv_msg_1_ep_b', shipped.body]]);
  });
});
