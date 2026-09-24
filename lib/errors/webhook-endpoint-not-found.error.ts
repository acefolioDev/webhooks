import { WebhooksError } from './webhooks.error.js';

/** The endpoint doesn't exist (or belongs to another tenant). Status 404. */
export class WebhookEndpointNotFoundError extends WebhooksError {
  readonly status = 404;
  constructor(readonly endpointId: string) {
    super(`Webhook endpoint ${endpointId} not found`);
  }
}
