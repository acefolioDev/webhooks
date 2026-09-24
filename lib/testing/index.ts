/**
 * `@nestjs/webhooks/testing`: the store contracts as runner-agnostic test suites, and a
 * helper that signs test payloads for your `@VerifyWebhook()` routes.
 *
 * ```ts
 * import { signWebhook, webhookDeliveryStoreContract, webhookEndpointStoreContract } from '@nestjs/webhooks/testing';
 *
 * describe('DrizzleWebhookStore', () => {
 *   const harness = async () => ({ store: new DrizzleWebhookStore(db, new WebhooksStorage()) });
 *   for (const c of webhookEndpointStoreContract(harness, { concurrent: true })) it(c.name, c.run);
 *   for (const c of webhookDeliveryStoreContract(harness, { concurrent: true })) it(c.name, c.run);
 * });
 * ```
 *
 * Each case creates its own harness (give each one empty tables), runs, and closes it. A case
 * throws (an `AssertionError`) when the store breaks the rule its name states.
 */
export {
  webhookDeliveryStoreContract,
  webhookEndpointStoreContract,
  type WebhookStoreContractCase,
  type WebhookStoreContractOptions,
  type WebhookStoreHarness,
} from './contracts.js';
export { signWebhook, type SignedWebhook, type SignWebhookOptions } from './sign.js';
