import { WebhooksError } from './webhooks.error.js';

/**
 * An endpoint the caller asked for can't be accepted: a URL that isn't https (unless
 * `delivery.allowHttp`), carries credentials, or points at a blocked address; an unknown
 * event type; a malformed secret. Status 400. `field` names the input.
 */
export class InvalidWebhookEndpointError extends WebhooksError {
  readonly status = 400;
  constructor(
    readonly field: 'url' | 'eventTypes' | 'secret' | 'description' | 'tenant',
    message: string,
  ) {
    super(message);
  }
}
