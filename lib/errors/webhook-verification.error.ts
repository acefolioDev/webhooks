import { WebhooksError } from './webhooks.error.js';

/** Why an incoming webhook was refused. */
export type WebhookVerificationFailure =
  /** A header the scheme needs is missing, or the body isn't there. */
  | 'missing-header'
  /** A header is there but can't be parsed (a timestamp that isn't a number, an unknown format). */
  | 'malformed-header'
  /** No signature in the request matches any configured secret. */
  | 'invalid-signature'
  /** The signed timestamp is further from now than `tolerance`, in either direction. */
  | 'timestamp-out-of-tolerance'
  /** The signature is valid but the body isn't JSON. */
  | 'invalid-payload';

/**
 * An incoming webhook failed verification. Status 401 (400 for a body that isn't JSON).
 * `@VerifyWebhook()` answers with Nest's `UnauthorizedException` (or `BadRequestException`)
 * and keeps the reason out of the response; `WebhookVerifier.verify()` throws this error.
 */
export class WebhookVerificationError extends WebhooksError {
  readonly status: 400 | 401;
  constructor(
    readonly receiver: string,
    readonly reason: WebhookVerificationFailure,
    detail: string,
  ) {
    super(`Webhook from "${receiver}" refused (${reason}): ${detail}`);
    this.status = reason === 'invalid-payload' ? 400 : 401;
  }
}
