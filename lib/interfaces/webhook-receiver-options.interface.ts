import type { Duration } from './duration.interface.js';
import type { WebhookSignatureScheme } from '../signing/webhook-signature.scheme.js';

/** Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,…`). */
export interface StandardWebhookReceiverOptions {
  scheme: 'standard';
  /** `whsec_…`, or several while the sender rotates (every one is tried). */
  secret: string | readonly string[];
  /** Largest accepted distance between the signed timestamp and now. Default `'5m'`. */
  tolerance?: Duration;
}

/**
 * Stripe's scheme (`Stripe-Signature: t=…,v1=…`: hex HMAC-SHA256 of `t.body`, keyed with the
 * secret's text), and senders that copied it under another header name.
 */
export interface StripeWebhookReceiverOptions {
  scheme: 'stripe';
  secret: string | readonly string[];
  /** Default `'5m'`. */
  tolerance?: Duration;
  /** Default `'stripe-signature'`. */
  header?: string;
  /** The deduplication id. Default: the payload's `id` (signed, unlike any header). */
  id?: (payload: any) => string;
}

/**
 * GitHub's scheme (`X-Hub-Signature-256: sha256=…`: hex HMAC-SHA256 of the body). It signs no
 * timestamp and no id, so a captured delivery verifies forever, and one replayed with a new
 * `X-GitHub-Delivery` header isn't deduplicated either. Key `id` on the signed body to skip
 * replays the inbox still remembers: https://docs.nestjs.com/http/webhooks#other-senders
 */
export interface GitHubWebhookReceiverOptions {
  scheme: 'github';
  secret: string | readonly string[];
  /**
   * The deduplication id. Default: the `X-GitHub-Delivery` header, which isn't signed: whoever
   * replays a captured request can set a new one.
   */
  id?: (payload: any, headers: WebhookHeaders) => string;
}

/** A scheme of your own: a `WebhookSignatureScheme` instance. */
export interface CustomWebhookReceiverOptions {
  scheme: WebhookSignatureScheme;
  secret: string | readonly string[];
  /** Default `'5m'`; used when the scheme's `verify()` returns a timestamp. */
  tolerance?: Duration;
}

export type WebhookReceiverOptions = (
  | StandardWebhookReceiverOptions
  | StripeWebhookReceiverOptions
  | GitHubWebhookReceiverOptions
  | CustomWebhookReceiverOptions
) & {
  /**
   * Skip a webhook id this receiver already processed (`OutboxInbox`). Default `true`. The
   * id is recorded after the handler succeeds.
   */
  dedupe?: boolean;
  /** The inbox consumer name. Default `webhooks:<receiver name>`. Keep it stable. */
  consumer?: string;
};

/** Request headers, lower-case names. */
export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;
