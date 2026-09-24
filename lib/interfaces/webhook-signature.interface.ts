import type { WebhookHeaders } from './webhook-receiver-options.interface.js';
import type { WebhookVerificationFailure } from '../errors/webhook-verification.error.js';

/** What a scheme checks: the request's headers (lower-case names) and its body as received. */
export interface WebhookSignedRequest {
  headers: WebhookHeaders;
  rawBody: Buffer;
}

/** What a scheme concluded. */
export type WebhookSignatureCheck =
  | {
      valid: true;
      /** The id the sender gives this webhook, when the scheme carries one in a header. */
      id?: string;
      /** The signed timestamp, in epoch seconds, when the scheme signs one. */
      timestamp?: number;
    }
  | { valid: false; reason: WebhookVerificationFailure; detail: string };
