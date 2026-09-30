import type { StoreMigration } from '@nestjs/store-kit/postgres';

/**
 * The store's tables. Times are epoch milliseconds from the package's clock (`bigint`), as the store contracts pass
 * them; secrets and event types are JSON arrays (`jsonb`), in order. A message's body is `text`: it is the exact JSON
 * that was signed, and `jsonb` would reformat it.
 */
export const initialMigration: StoreMigration = {
  version: 1,
  name: 'initial',
  up: (s) => [
    `CREATE TABLE ${s}.endpoints (
  id text PRIMARY KEY,
  tenant text,
  url text NOT NULL,
  event_types jsonb NOT NULL,
  description text,
  enabled boolean NOT NULL,
  disabled_reason text,
  failing_since bigint,
  secrets jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
)`,
    `CREATE TABLE ${s}.messages (
  id text PRIMARY KEY,
  type text NOT NULL,
  tenant text,
  body text NOT NULL,
  created_at bigint NOT NULL
)`,
    // One delivery per message and endpoint: a fan-out that runs again inserts only what is missing. No foreign key
    // to the endpoint: a deleted endpoint's log stays.
    `CREATE TABLE ${s}.deliveries (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES ${s}.messages (id),
  endpoint_id text NOT NULL,
  tenant text,
  type text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  next_attempt_at bigint,
  last_attempt_at bigint,
  last_status_code integer,
  last_error text,
  failure_reason text,
  created_at bigint NOT NULL,
  completed_at bigint,
  lease_owner text,
  lease_until bigint,
  CONSTRAINT deliveries_message_endpoint UNIQUE (message_id, endpoint_id)
)`,
    `CREATE TABLE ${s}.delivery_attempts (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES ${s}.deliveries (id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  at bigint NOT NULL,
  duration_ms integer NOT NULL,
  status_code integer,
  response text,
  error text
)`,
    // What the fan-out and listEndpoints({ tenant }) look for.
    `CREATE INDEX endpoints_tenant ON ${s}.endpoints (tenant, created_at, id)`,
    // What claims look for, most overdue first, and what stats() counts: pending deliveries, whatever the log's size.
    `CREATE INDEX deliveries_due ON ${s}.deliveries (next_attempt_at, created_at, id) WHERE status = 'pending'`,
    // What the delivery log lists, newest first: all of it, an endpoint's, a tenant's.
    `CREATE INDEX deliveries_created ON ${s}.deliveries (created_at, id)`,
    `CREATE INDEX deliveries_endpoint ON ${s}.deliveries (endpoint_id, created_at, id)`,
    `CREATE INDEX deliveries_tenant ON ${s}.deliveries (tenant, created_at, id)`,
    // What stats() counts and the log lists by status 'failed', without reading the deliveries that succeeded.
    `CREATE INDEX deliveries_failed ON ${s}.deliveries (created_at, id) WHERE status = 'failed'`,
    // What retention deletes: finished deliveries by completion time.
    `CREATE INDEX deliveries_finished ON ${s}.deliveries (completed_at) WHERE status <> 'pending'`,
    // A delivery's log, oldest first, and the cascade from a deleted delivery.
    `CREATE INDEX delivery_attempts_delivery ON ${s}.delivery_attempts (delivery_id, at, attempt)`,
  ],
};
