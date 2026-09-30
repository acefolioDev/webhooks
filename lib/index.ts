// Module and options
export { WebhooksModule } from './webhooks.module.js';
export { WEBHOOKS_MODULE_OPTIONS } from './webhooks.module-definition.js';
export type {
  WebhookBackoffOptions,
  WebhookDeliveryOptions,
  WebhookEncryptionOptions,
  WebhookRetryOptions,
  WebhooksModuleAsyncOptions,
  WebhooksModuleOptions,
  WebhooksOptionsFactory,
  WebhookWorkerOptions,
} from './interfaces/index.js';
export type { Duration } from './interfaces/index.js';

// Sending: dispatch inside your transaction
export { Webhooks } from './webhooks.service.js';
export { WEBHOOKS_OUTBOX_TOPIC } from './webhooks.constants.js';
export type { NewWebhookMessage, WebhookMessage } from './interfaces/index.js';

// Endpoints (subscriptions)
export { WebhookEndpoints } from './services/index.js';
export type {
  CreatedWebhookEndpoint,
  CreateWebhookEndpoint,
  UpdateWebhookEndpoint,
  WebhookEndpoint,
  WebhookEndpointDisabledReason,
  WebhookTenantScope,
} from './interfaces/index.js';

// Deliveries: the log, replay, the worker
export { WebhookDeliveries, WebhookWorker } from './services/index.js';
export type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryDetails,
  WebhookDeliveryFailureReason,
  WebhookDeliveryFilter,
  WebhookDeliveryQuery,
  WebhookDeliveryStats,
  WebhookDeliveryStatus,
  WebhookWorkerRunResult,
} from './interfaces/index.js';

// Receiving: verify, deduplicate, read the payload
export * from './decorators/index.js';
export { WebhookVerifier } from './services/index.js';
export { WebhookSignatureScheme } from './signing/webhook-signature.scheme.js';
export type {
  CustomWebhookReceiverOptions,
  GitHubWebhookReceiverOptions,
  StandardWebhookReceiverOptions,
  StripeWebhookReceiverOptions,
  WebhookHeaders,
  WebhookReceiverOptions,
  WebhookSignatureCheck,
  WebhookSignedRequest,
  WebhookVerifyRequest,
} from './interfaces/index.js';

// Transports: the SSRF-guarded default, your own, and the one for tests
export * from './transports/index.js';
export { HttpWebhookTransport } from './network/http.transport.js';
export type {
  HttpWebhookTransportOptions,
  InMemoryWebhookResponder,
  ResolvedAddress,
  SentWebhookQuery,
  WebhookRequest,
  WebhookTransportResponse,
  WebhookTransportSendOptions,
} from './interfaces/index.js';

// Events
export {
  WebhooksEvents,
  type WebhooksDeliveredEvent,
  type WebhooksDeliveryFailedEvent,
  type WebhooksDestinationBlockedEvent,
  type WebhooksEndpointDisabledEvent,
  type WebhooksEvent,
  type WebhooksRetryScheduledEvent,
  type WebhooksVerificationFailedEvent,
} from './events/index.js';

// Errors
export * from './errors/index.js';

// Storage: implement WebhookEndpointStore and WebhookDeliveryStore in a provider and register it
export { WebhooksStorage } from './storage/index.js';
export type {
  WebhookClaimedDelivery,
  WebhookClaimRequest,
  WebhookDeliveryStore,
  WebhookDeliveryStoreStats,
  WebhookDeliveryUpdate,
  WebhookEndpointFailure,
  WebhookEndpointPatch,
  WebhookEndpointQuery,
  WebhookEndpointRecord,
  WebhookEndpointSecret,
  WebhookEndpointStore,
  WebhooksStorageContract,
  WebhooksStorageRegisterOptions,
  WebhooksStorageSources,
} from './interfaces/index.js';
// The default and test double. In production, the store lives in the app's database: PostgresWebhookStore
// (@nestjs/webhooks/postgres), MySqlWebhookStore (@nestjs/webhooks/mysql), or one of the app's own.
export * from './stores/index.js';
