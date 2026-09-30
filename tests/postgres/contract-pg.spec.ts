/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on PostgresWebhookStore
 * through pgClient's executor on PostgreSQL, races included: a pool of real connections.
 */
import { describeContract, pgClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('pgstore_contract_pg');

describeContract(`PostgresWebhookStore through ${pgClient.name} on PostgreSQL`, async () => (database ? pgClient.open(database.url) : null), 'nest_webhooks', reason);
