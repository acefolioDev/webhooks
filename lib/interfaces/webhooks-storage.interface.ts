import type { WebhookEndpointStore } from './webhook-endpoint-store.interface.js';
import type { WebhookDeliveryStore } from './webhook-delivery-store.interface.js';

/**
 * The storage contracts, by name: what `registerSource()` takes. One provider usually
 * implements both (`{ endpoints: this, deliveries: this }`); they may come from different ones.
 */
export interface WebhooksStorageSources {
  /** Endpoints and their secrets: what `WebhookEndpoints`, the fan-out and the worker read. */
  endpoints?: WebhookEndpointStore;
  /** Messages, deliveries and attempt logs: what the fan-out, the worker and `WebhookDeliveries` use. */
  deliveries?: WebhookDeliveryStore;
}

export type WebhooksStorageContract = keyof WebhooksStorageSources;

/** `registerSource()` options. */
export interface WebhooksStorageRegisterOptions {
  /** Replace a source that is already registered (tests, a wrapper around it). */
  replace?: boolean;
}
