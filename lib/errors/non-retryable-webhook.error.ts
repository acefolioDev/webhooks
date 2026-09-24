/** Throw from a custom `WebhookTransport` to fail the delivery without retrying it. */
export class NonRetryableWebhookError extends Error {
  override name = 'NonRetryableWebhookError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
