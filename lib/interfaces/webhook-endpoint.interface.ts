export type WebhookEndpointDisabledReason =
  /** `WebhookEndpoints.update(id, { enabled: false })`. */
  | 'manual'
  /** Every attempt failed for `disableEndpointAfter`. */
  | 'failing'
  /** The endpoint answered 410 Gone. */
  | 'gone';

/** A subscription: where to send which messages. Secrets are read with `getSecret()`, never listed. */
export interface WebhookEndpoint {
  readonly id: string;
  readonly tenant: string | null;
  readonly url: string;
  /** Message types it receives; `*` means every type. */
  readonly eventTypes: readonly string[];
  readonly description: string | null;
  readonly enabled: boolean;
  readonly disabledReason: WebhookEndpointDisabledReason | null;
  /** Epoch ms of the first failed attempt since the last success, or null while it's healthy. */
  readonly failingSince: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebhookEndpointQuery {
  /** `undefined`: every tenant. `null`: endpoints without a tenant. */
  tenant?: string | null;
  /** Default 50. */
  limit?: number;
  offset?: number;
}

/** `WebhookEndpoints.create()` input. */
export interface CreateWebhookEndpoint {
  url: string;
  /** Message types to receive; `['*']` for every type. */
  eventTypes: readonly string[];
  /** The owner (a partner, an account): it receives only messages dispatched with this tenant. */
  tenant?: string | null;
  description?: string | null;
  /** A `whsec_…` secret to use instead of a generated one (an endpoint moved from another system). */
  secret?: string;
}

/** `WebhookEndpoints.update()` input: the fields to change. */
export interface UpdateWebhookEndpoint {
  url?: string;
  eventTypes?: readonly string[];
  description?: string | null;
  /** `true` re-enables a disabled endpoint and forgets its failures; `false` disables it (`manual`). */
  enabled?: boolean;
}

/** Restricts a call to one tenant's endpoints: another tenant's id behaves as if it didn't exist. */
export interface WebhookTenantScope {
  tenant?: string | null;
}

/** `create()`'s result: the endpoint, and its secret, shown this once. */
export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  readonly secret: string;
}
