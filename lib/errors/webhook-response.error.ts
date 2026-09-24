import { WebhooksError } from './webhooks.error.js';

/** The endpoint answered with a status outside 2xx. Retried (410 Gone disables the endpoint). */
export class WebhookResponseError extends WebhooksError {
  constructor(
    readonly statusCode: number,
    /** From a `Retry-After` header, when the response had one. */
    readonly retryAfterMs?: number,
  ) {
    super(`Endpoint responded ${statusCode}`);
  }
}
