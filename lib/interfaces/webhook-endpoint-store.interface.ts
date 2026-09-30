
import type { WebhookEndpointQuery } from './webhook-endpoint.interface.js';
import type { Awaitable } from './awaitable.interface.js';
import type { WebhookEndpointDisabledReason, WebhookEndpoint } from './webhook-endpoint.interface.js';

/**
 * Where the endpoints (subscriptions) live: what `WebhookEndpoints` manages and the worker
 * reads before each attempt. `PostgresWebhookStore` (`@nestjs/webhooks/postgres`) implements
 * it; so can a provider of the application's, with whatever it already uses, which registers
 * itself: `WebhooksStorage.registerSource({ endpoints: this, deliveries: this })`. Without one,
 * the module uses `InMemoryWebhookStore`.
 *
 * No method takes the application's transaction: the outbox carries a dispatched message
 * out of the transaction, and everything here runs on the store's own connection. Every
 * method may return its result or a promise of it. `@nestjs/webhooks/testing` exports
 * `webhookEndpointStoreContract()`, the suite every implementation passes. Each method's
 * rule, and the race it prevents: https://docs.nestjs.com/http/webhooks#the-store-contract
 */
export interface WebhookEndpointStore {
  /** Inserts the endpoint. Its `id` is new; its secrets are newest first. */
  createEndpoint(endpoint: WebhookEndpointRecord): Awaitable<void>;

  /** The endpoint with every secret it still has, or `undefined`. */
  getEndpoint(id: string): Awaitable<WebhookEndpointRecord | undefined>;

  /**
   * Endpoints of `query.tenant` (every tenant when `undefined`, the ones without a tenant
   * when `null`), newest first (`createdAt`, then `id`, descending), `limit` 50 by default.
   */
  listEndpoints(query: WebhookEndpointQuery): Awaitable<WebhookEndpointRecord[]>;

  /**
   * The enabled endpoints of exactly this tenant (`null` matches only `null`) whose
   * `eventTypes` contain `type` or `*`. Never another tenant's: this is the fan-out's query.
   */
  findSubscribedEndpoints(tenant: string | null, type: string): Awaitable<WebhookEndpointRecord[]>;

  /**
   * Applies the fields present in `patch` and sets `updatedAt` to `now`, in one write.
   * Returns the updated endpoint, or `undefined` when there is none.
   */
  updateEndpoint(id: string, patch: WebhookEndpointPatch, now: number): Awaitable<WebhookEndpointRecord | undefined>;

  /** Deletes the endpoint. `true` if it existed. */
  deleteEndpoint(id: string): Awaitable<boolean>;

  /**
   * Rotation, atomically: every existing secret's `expiresAt` becomes the earlier of its own
   * and `expireOthersAt`, secrets that expired by `now` are dropped, and `secret` goes first.
   * Two rotations at once both land (serialize them on the row). `false` when the endpoint
   * doesn't exist.
   */
  addEndpointSecret(id: string, secret: WebhookEndpointSecret, expireOthersAt: number, now: number): Awaitable<boolean>;

  /**
   * A failed attempt, atomically: `failingSince` becomes `failingSince ?? failure.at`; then,
   * if the endpoint is enabled and `failingSince <= failure.disableIfFailingSince`, it is
   * disabled with `failure.reason`. Returns `true` only for the call that disabled it.
   */
  recordEndpointFailure(id: string, failure: WebhookEndpointFailure): Awaitable<boolean>;

  /** A successful attempt: `failingSince` becomes `null`. */
  recordEndpointSuccess(id: string): Awaitable<void>;
}

/** One signing secret of an endpoint. */
export interface WebhookEndpointSecret {
  /** `whsec_…`, or its sealed form when `encryption` is configured. */
  readonly secret: string;
  readonly createdAt: number;
  /** Epoch ms after which it no longer signs (a rotated-out secret), or null. */
  readonly expiresAt: number | null;
}

/** An endpoint as the store keeps it: with its secrets, newest first. */
export interface WebhookEndpointRecord extends WebhookEndpoint {
  readonly secrets: readonly WebhookEndpointSecret[];
}

/** What `WebhookEndpointStore.updateEndpoint()` changes; absent fields stay. */
export interface WebhookEndpointPatch {
  url?: string;
  eventTypes?: readonly string[];
  description?: string | null;
  enabled?: boolean;
  disabledReason?: WebhookEndpointDisabledReason | null;
  failingSince?: number | null;
}

/** `WebhookEndpointStore.recordEndpointFailure()` input. */
export interface WebhookEndpointFailure {
  /** Epoch ms of the failed attempt. */
  at: number;
  /**
   * Disable the endpoint when it has been failing since this time or earlier (`at` for at
   * once), or never (`null`).
   */
  disableIfFailingSince: number | null;
  /** Recorded as `disabledReason` when this call disables it. */
  reason: Exclude<WebhookEndpointDisabledReason, 'manual'>;
}
