import { WebhooksError } from './webhooks.error.js';

/** The attempt outlived `delivery.timeout` (connecting, sending, or reading the response). */
export class WebhookDeliveryTimeoutError extends WebhooksError {
  constructor(readonly timeoutMs: number) {
    super(`No response within ${timeoutMs}ms`);
  }
}
