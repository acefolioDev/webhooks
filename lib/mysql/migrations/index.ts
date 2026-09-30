import { StoreSchema } from '@nestjs/store-kit/mysql';
import { WebhookSchemaError } from '../../postgres/errors/webhook-schema.error.js';
import { initialMigration } from './initial.migration.js';

/**
 * MySqlWebhookStore's schema: every version of it, in order (a new one goes last, and none ever changes once
 * released), and what the store, its statics and `nest-webhooks` do with them. Its tables live in the connection's
 * database, named `<schema>_<table>` (`nest_webhooks_deliveries`).
 */
export const mysqlWebhookStoreSchema = new StoreSchema({
  packageName: '@nestjs/webhooks',
  storeName: 'MySqlWebhookStore',
  command: 'nest-webhooks',
  defaultSchema: 'nest_webhooks',
  migrations: [initialMigration],
  createError: (message, details) => new WebhookSchemaError(message, details),
});
