import type { WebhookRequest, WebhookTransportResponse } from './webhook-transport.interface.js';
import { SentWebhook } from '../transports/sent-webhook.js';

/** Which requests to match: every given field must match; a function gets each `SentWebhook`. */
export type SentWebhookQuery =
  | { type?: string; url?: string | RegExp; endpointId?: string; messageId?: string }
  | ((sent: SentWebhook) => boolean);

/** What `respondWith()`'s function returns: a status, a response, or throws for "no response". */
export type InMemoryWebhookResponder = (
  request: WebhookRequest,
  attempt: number,
) => number | Partial<WebhookTransportResponse> | Promise<number | Partial<WebhookTransportResponse>>;
