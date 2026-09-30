import { StoreSchema } from '@nestjs/store-kit/postgres';
import { WebhookSchemaError } from '../errors/webhook-schema.error.js';
import { initialMigration } from './initial.migration.js';

/**
 * PostgresWebhookStore's schema: every version of it, in order (a new one goes last, and none ever changes once
 * released), and what the store, its statics and `nest-webhooks` do with them.
 */
export const webhookStoreSchema = new StoreSchema({
  packageName: '@nestjs/webhooks',
  storeName: 'PostgresWebhookStore',
  command: 'nest-webhooks',
  defaultSchema: 'nest_webhooks',
  migrations: [initialMigration],
  createError: (message, details) => new WebhookSchemaError(message, details),
});
