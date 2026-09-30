/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on MySqlWebhookStore
 * through kyselyClient's executor on MySQL, races included: a pool of real connections.
 */
import { describeContract, kyselyClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_contract_kysely');

describeContract(`MySqlWebhookStore through ${kyselyClient.name} on MySQL`, async () => (database ? kyselyClient.open(database.url) : null), 'nest_webhooks', reason);
