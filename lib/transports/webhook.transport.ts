import type { WebhookRequest, WebhookTransportSendOptions, WebhookTransportResponse } from '../interfaces/webhook-transport.interface.js';

/**
 * Sends webhook requests. The default is the SSRF-guarded HTTP transport the `delivery`
 * options configure. The abstract class is also the injection token, so a test swaps it
 * with `overrideProvider(WebhookTransport).useValue(new InMemoryWebhookTransport())`, and an
 * app with other needs (a proxy such as smokescreen, mTLS) provides its own.
 *
 * `send()` resolves with the response whatever its status, and throws when there is none
 * (DNS, connection, TLS, timeout). `WebhookDestinationBlockedError` and
 * `NonRetryableWebhookError` fail the delivery without retrying; anything else is retried.
 */
export abstract class WebhookTransport {
  abstract send(request: WebhookRequest, options: WebhookTransportSendOptions): Promise<WebhookTransportResponse>;
}
