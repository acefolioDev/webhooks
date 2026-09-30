/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on MySqlWebhookStore
 * through typeOrmClient's executor on MySQL, races included: a pool of real connections.
 */
import { describeContract, typeOrmClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_contract_typeorm');

describeContract(`MySqlWebhookStore through ${typeOrmClient.name} on MySQL`, async () => (database ? typeOrmClient.open(database.url) : null), 'nest_webhooks', reason);
