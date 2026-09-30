/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on MySqlWebhookStore
 * through drizzleClient's executor on MySQL, races included: a pool of real connections.
 */
import { describeContract, drizzleClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_contract_drizzle');

describeContract(`MySqlWebhookStore through ${drizzleClient.name} on MySQL`, async () => (database ? drizzleClient.open(database.url) : null), 'nest_webhooks', reason);
