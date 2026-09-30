/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on MySqlWebhookStore
 * through mysql2Client's executor on MySQL, races included: a pool of real connections.
 */
import { describeContract, mysql2Client, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_contract_mysql2');

describeContract(`MySqlWebhookStore through ${mysql2Client.name} on MySQL`, async () => (database ? mysql2Client.open(database.url) : null), 'nest_webhooks', reason);
