/**
 * Base class of the errors this package raises that an application may catch: the 4xx
 * errors of the endpoint and delivery APIs, and the delivery failures `retry.retryIf` and the
 * events see. `NonRetryableWebhookError` is not one of them: your transport throws it.
 */
export abstract class WebhooksError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
