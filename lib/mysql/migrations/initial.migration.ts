import { keyColumn, type StoreMigration } from '@nestjs/store-kit/mysql';

/**
 * The lengths of the key columns, in characters: ids (the package makes 40-character ones), a tenant (the package's
 * own limit) and a lease's owner (the worker's UUID). The store refuses a longer value before it writes, rather than
 * letting MySQL fail the statement: InnoDB bounds an index key at 3,072 bytes, and these keys share indexes.
 */
export const KEY_LENGTHS = { id: 255, tenant: 256, owner: 255 } as const;

/**
 * Every table's options: InnoDB (row locks, `SKIP LOCKED`, transactions), and text in `utf8mb4` compared by its
 * characters (`utf8mb4_0900_bin`), whatever the database's defaults are: event types, statuses and every other text
 * column compare exactly, as the key columns (`keyColumn()`) do.
 */
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';

const ID = keyColumn(KEY_LENGTHS.id);
const TENANT = keyColumn(KEY_LENGTHS.tenant);

/**
 * The store's tables on MySQL: the PostgreSQL store's, redesigned for InnoDB. Times are epoch milliseconds from the
 * package's clock (`bigint`), as the store contracts pass them; secrets and event types are JSON arrays, in order. A
 * message's body is `longtext`: it is the exact JSON that was signed, which a `json` column would reformat, and has no
 * size limit, like a response the worker keeps (`delivery.maxResponseSize` has none either). An event type is `text`:
 * the package doesn't bound it, and a longer type than a column holds would fail its fan-out at every retry.
 *
 * No foreign keys: a delivery's insert would take a shared lock on its message, and the store deletes a delivery's
 * attempts itself. MySQL has no partial indexes: the claim's index leads with the status.
 */
export const initialMigration: StoreMigration = {
  version: 1,
  name: 'initial',
  up: (t) => [
    // The fan-out looks up a tenant's endpoints, listEndpoints({ tenant }) lists them newest first.
    `CREATE TABLE ${t('endpoints')} (
  id ${ID} NOT NULL PRIMARY KEY,
  tenant ${TENANT},
  url text NOT NULL,
  event_types json NOT NULL,
  description text,
  enabled boolean NOT NULL,
  disabled_reason varchar(32),
  failing_since bigint,
  secrets json NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  INDEX endpoints_tenant (tenant, created_at, id)
) ${TABLE}`,
    `CREATE TABLE ${t('messages')} (
  id ${ID} NOT NULL PRIMARY KEY,
  type text NOT NULL,
  tenant ${TENANT},
  body longtext NOT NULL,
  created_at bigint NOT NULL
) ${TABLE}`,
    // One delivery per message and endpoint: a fan-out that runs again inserts only what is missing. The endpoint's id
    // is no reference: a deleted endpoint's log stays.
    `CREATE TABLE ${t('deliveries')} (
  id ${ID} NOT NULL PRIMARY KEY,
  message_id ${ID} NOT NULL,
  endpoint_id ${ID} NOT NULL,
  tenant ${TENANT},
  type text NOT NULL,
  status varchar(16) NOT NULL,
  attempts int NOT NULL,
  next_attempt_at bigint,
  last_attempt_at bigint,
  last_status_code int,
  last_error text,
  failure_reason varchar(32),
  created_at bigint NOT NULL,
  completed_at bigint,
  lease_owner ${keyColumn(KEY_LENGTHS.owner)},
  lease_until bigint,
  UNIQUE INDEX deliveries_message_endpoint (message_id, endpoint_id),
  INDEX deliveries_due (status, next_attempt_at, created_at, id),
  INDEX deliveries_status (status, created_at, id),
  INDEX deliveries_created (created_at, id),
  INDEX deliveries_endpoint (endpoint_id, created_at, id),
  INDEX deliveries_tenant (tenant, created_at, id),
  INDEX deliveries_finished (completed_at)
) ${TABLE}`,
    `CREATE TABLE ${t('delivery_attempts')} (
  seq bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  delivery_id ${ID} NOT NULL,
  attempt int NOT NULL,
  at bigint NOT NULL,
  duration_ms int NOT NULL,
  status_code int,
  response longtext,
  error text,
  INDEX delivery_attempts_delivery (delivery_id, at, attempt)
) ${TABLE}`,
  ],
};
