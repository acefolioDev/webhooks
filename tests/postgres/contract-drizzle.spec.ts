/**
 * The WebhookEndpointStore and WebhookDeliveryStore contracts (`@nestjs/webhooks/testing`) on PostgresWebhookStore
 * through fromDrizzle(): on PostgreSQL (a pool of real connections, races included), and on PGlite (one connection,
 * which serializes every race).
 */
import { describeContract, drizzleClient, openPglite, testDatabase } from './support.js';

const { database, reason } = await testDatabase('pgstore_contract_drizzle');

describeContract(`PostgresWebhookStore through ${drizzleClient.name} on PostgreSQL`, async () => (database ? drizzleClient.open(database.url) : null), 'nest_webhooks', reason);

describeContract('PostgresWebhookStore through fromDrizzle (PGlite)', openPglite, 'nest_webhooks');
