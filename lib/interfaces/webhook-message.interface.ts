/** Input to `Webhooks.dispatch()`. */
export interface NewWebhookMessage<D = unknown> {
  /** Full-stop delimited, `[A-Za-z0-9_-]` segments: `order.shipped`. In `eventTypes` when that option is set. */
  type: string;
  /** The event's data, sent as the body's `data`. JSON-serializable. */
  data: D;
  /**
   * Who may receive it: only endpoints of this tenant (a partner, an account). `null` (the
   * default) reaches only endpoints created without a tenant, never every tenant's.
   */
  tenant?: string | null;
  /** `webhook-id`. Defaults to `msg_` and a UUIDv7. Letters, digits, `_` and `-`, at most 128. */
  id?: string;
}

/**
 * A message as stored and sent. `body` is the exact JSON every endpoint receives on every
 * attempt: `{"type":…,"timestamp":…,"data":…}`, the Standard Webhooks payload.
 */
export interface WebhookMessage {
  readonly id: string;
  readonly type: string;
  readonly tenant: string | null;
  readonly body: string;
  /** Epoch ms: when it was dispatched, the body's `timestamp`. */
  readonly createdAt: number;
}
