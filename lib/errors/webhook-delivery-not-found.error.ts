import { WebhooksError } from './webhooks.error.js';

/** The delivery doesn't exist (or belongs to another tenant). Status 404. */
export class WebhookDeliveryNotFoundError extends WebhooksError {
  readonly status = 404;
  constructor(readonly deliveryId: string) {
    super(`Webhook delivery ${deliveryId} not found`);
  }
}
