/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on PostgresWebhookStore
 * through typeOrmClient's executor on PostgreSQL, races included: a pool of real connections.
 */
import { describeContract, testDatabase, typeOrmClient } from './support.js';

const { database, reason } = await testDatabase('pgstore_contract_typeorm');

describeContract(`PostgresWebhookStore through ${typeOrmClient.name} on PostgreSQL`, async () => (database ? typeOrmClient.open(database.url) : null), 'nest_webhooks', reason);
