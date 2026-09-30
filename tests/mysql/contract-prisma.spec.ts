/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on MySqlWebhookStore
 * through prismaClient's executor on MySQL, races included: a pool of real connections.
 */
import { describeContract, prismaClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('mystore_contract_prisma');

describeContract(`MySqlWebhookStore through ${prismaClient.name} on MySQL`, async () => (database ? prismaClient.open(database.url) : null), 'nest_webhooks', reason);
