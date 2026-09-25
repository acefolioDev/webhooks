// The store's tables, the outbox's and the webhooks', on PostgreSQL, for Drizzle and drizzle-kit.
import type { OutboxAttempt, OutboxDeadLetterReason } from '@nestjs/outbox';
import type {
  WebhookDeliveryFailureReason,
  WebhookDeliveryStatus,
  WebhookEndpointDisabledReason,
  WebhookEndpointSecret,
} from '../../../lib/index.js';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import type { OrderItem, OrderStatus } from '../orders/order.js';

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** In cents. */
  price: integer('price').notNull(),
});

/** The cat shelters and resellers that buy in bulk over the store's API, and receive its webhooks. */
export const partners = pgTable('partners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 of the partner's API key, hex. */
  apiKeyHash: text('api_key_hash').notNull().unique(),
});

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  partnerId: text('partner_id')
    .notNull()
    .references(() => partners.id),
  items: jsonb('items').$type<OrderItem[]>().notNull(),
  /** In cents. */
  total: integer('total').notNull(),
  status: text('status').$type<OrderStatus>().notNull(),
  paymentId: text('payment_id'),
  trackingNumber: text('tracking_number'),
});

// The outbox's tables (see the outbox tutorial), read and written by DrizzleOutboxStore.

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    id: text('id').notNull().unique(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<unknown>(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull(),
    key: text('key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    history: jsonb('history').$type<OutboxAttempt[]>().notNull().default([]),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
  },
  (table) => [index('outbox_messages_key_seq').on(table.key, table.seq)],
);

export const outboxDeadLetters = pgTable(
  'outbox_dead_letters',
  {
    id: text('id').primaryKey(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<unknown>(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull(),
    key: text('key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    history: jsonb('history').$type<OutboxAttempt[]>().notNull(),
    reason: text('reason').$type<OutboxDeadLetterReason>().notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('outbox_dead_letters_topic_failed_at').on(table.topic, table.failedAt)],
);

export const outboxInbox = pgTable(
  'outbox_inbox',
  {
    consumer: text('consumer').notNull(),
    messageId: text('message_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.messageId] }),
    index('outbox_inbox_processed_at').on(table.processedAt),
  ],
);

// The webhooks' tables, read and written by DrizzleWebhookStore.

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    /** The partner that owns the endpoint; null for the store's own endpoints. */
    tenant: text('tenant'),
    url: text('url').notNull(),
    eventTypes: text('event_types').array().notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull(),
    disabledReason: text('disabled_reason').$type<WebhookEndpointDisabledReason>(),
    failingSince: timestamp('failing_since', { withTimezone: true }),
    /** Newest first; sealed when WebhooksModule has encryption keys. */
    secrets: jsonb('secrets').$type<WebhookEndpointSecret[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('webhook_endpoints_tenant_created_at').on(table.tenant, table.createdAt)],
);

export const webhookMessages = pgTable('webhook_messages', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  tenant: text('tenant'),
  /** The exact JSON every attempt sends: text, not jsonb, which would reformat it. */
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    /** No foreign key: a deleted endpoint's log stays. */
    endpointId: text('endpoint_id').notNull(),
    tenant: text('tenant'),
    type: text('type').notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull(),
    attempts: integer('attempts').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    failureReason: text('failure_reason').$type<WebhookDeliveryFailureReason>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
  },
  (table) => [
    // The fan-out's idempotency: one delivery per message and endpoint.
    unique('webhook_deliveries_message_endpoint').on(table.messageId, table.endpointId),
    foreignKey({ columns: [table.messageId], foreignColumns: [webhookMessages.id] }),
    // The worker's claim: pending deliveries by due time.
    index('webhook_deliveries_due').on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
    index('webhook_deliveries_endpoint_created_at').on(table.endpointId, table.createdAt),
    index('webhook_deliveries_tenant_created_at').on(table.tenant, table.createdAt),
    index('webhook_deliveries_completed_at').on(table.completedAt),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  'webhook_delivery_attempts',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    statusCode: integer('status_code'),
    response: text('response'),
    error: text('error'),
  },
  (table) => [index('webhook_delivery_attempts_delivery').on(table.deliveryId, table.at)],
);
