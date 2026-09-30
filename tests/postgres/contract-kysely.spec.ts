/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on PostgresWebhookStore
 * through kyselyClient's executor on PostgreSQL, races included: a pool of real connections.
 */
import { describeContract, kyselyClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('pgstore_contract_kysely');

describeContract(`PostgresWebhookStore through ${kyselyClient.name} on PostgreSQL`, async () => (database ? kyselyClient.open(database.url) : null), 'nest_webhooks', reason);
