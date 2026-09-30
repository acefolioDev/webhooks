import { toBool, toInt, toJson } from '@nestjs/store-kit/postgres';
import type { WebhookDelivery, WebhookDeliveryAttempt, WebhookDeliveryFailureReason, WebhookDeliveryStatus } from '../interfaces/webhook-delivery.interface.js';
import type { WebhookEndpointRecord, WebhookEndpointSecret } from '../interfaces/webhook-endpoint-store.interface.js';
import type { WebhookEndpointDisabledReason } from '../interfaces/webhook-endpoint.interface.js';
import type { WebhookMessage } from '../interfaces/webhook-message.interface.js';

// The SQL stores' rows and the records they hold, whatever the database: a store selects these columns in the text
// form below, and maps the rows with these functions.

/**
 * A row as the SQL stores read it: every column as text or `null`, which every driver and ORM hands over unchanged.
 * Integers are decimal text, booleans `'true'` or `'false'`, JSON its text: what `columns()` of
 * `@nestjs/store-kit/postgres` selects.
 */
export type SqlRow = Record<string, string | null>;

export const ENDPOINT_COLUMNS = [
  'id',
  'tenant',
  'url',
  'event_types',
  'description',
  'enabled',
  'disabled_reason',
  'failing_since',
  'secrets',
  'created_at',
  'updated_at',
] as const;

export const MESSAGE_COLUMNS = ['id', 'type', 'tenant', 'body', 'created_at'] as const;

export const DELIVERY_COLUMNS = [
  'id',
  'message_id',
  'endpoint_id',
  'tenant',
  'type',
  'status',
  'attempts',
  'next_attempt_at',
  'last_attempt_at',
  'last_status_code',
  'last_error',
  'failure_reason',
  'created_at',
  'completed_at',
] as const;

export const DELIVERY_ATTEMPT_COLUMNS = ['delivery_id', 'attempt', 'at', 'duration_ms', 'status_code', 'response', 'error'] as const;

export function toEndpointRecord(row: SqlRow): WebhookEndpointRecord {
  return {
    id: row.id!,
    tenant: row.tenant,
    url: row.url!,
    eventTypes: toJson(row.event_types) as string[],
    description: row.description,
    enabled: toBool(row.enabled),
    disabledReason: row.disabled_reason as WebhookEndpointDisabledReason | null,
    failingSince: toInt(row.failing_since),
    createdAt: toInt(row.created_at)!,
    updatedAt: toInt(row.updated_at)!,
    secrets: toJson(row.secrets) as WebhookEndpointSecret[],
  };
}

/** `prefix`: the message's columns selected under names of their own (`m_id`...), next to a delivery's. */
export function toMessage(row: SqlRow, prefix = ''): WebhookMessage {
  return {
    id: row[`${prefix}id`]!,
    type: row[`${prefix}type`]!,
    tenant: row[`${prefix}tenant`] ?? null,
    body: row[`${prefix}body`]!,
    createdAt: toInt(row[`${prefix}created_at`])!,
  };
}

export function toDelivery(row: SqlRow): WebhookDelivery {
  return {
    id: row.id!,
    messageId: row.message_id!,
    endpointId: row.endpoint_id!,
    tenant: row.tenant,
    type: row.type!,
    status: row.status as WebhookDeliveryStatus,
    attempts: toInt(row.attempts)!,
    nextAttemptAt: toInt(row.next_attempt_at),
    lastAttemptAt: toInt(row.last_attempt_at),
    lastStatusCode: toInt(row.last_status_code),
    lastError: row.last_error,
    failureReason: row.failure_reason as WebhookDeliveryFailureReason | null,
    createdAt: toInt(row.created_at)!,
    completedAt: toInt(row.completed_at),
  };
}

export function toDeliveryAttempt(row: SqlRow): WebhookDeliveryAttempt {
  return {
    deliveryId: row.delivery_id!,
    attempt: toInt(row.attempt)!,
    at: toInt(row.at)!,
    durationMs: toInt(row.duration_ms)!,
    statusCode: toInt(row.status_code),
    response: row.response,
    error: row.error,
  };
}
