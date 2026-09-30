/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on PostgresWebhookStore
 * through prismaClient's executor on PostgreSQL, races included: a pool of real connections.
 */
import { describeContract, prismaClient, testDatabase } from './support.js';

const { database, reason } = await testDatabase('pgstore_contract_prisma');

describeContract(`PostgresWebhookStore through ${prismaClient.name} on PostgreSQL`, async () => (database ? prismaClient.open(database.url) : null), 'nest_webhooks', reason);
