import { timingSafeEqual } from 'node:crypto';
import type { WebhookHeaders } from '../interfaces/webhook-receiver-options.interface.js';
import { textSecretKey } from './secrets.util.js';
import type { WebhookSignedRequest, WebhookSignatureCheck } from '../interfaces/webhook-signature.interface.js';

/**
 * A signature scheme for incoming webhooks. `standard`, `stripe` and `github` are built in;
 * extend this class for another sender and pass an instance as a receiver's `scheme`.
 * Compare signatures with `timingSafeEqual()` (or `WebhookSignatureScheme.matches()`), never `===`.
 */
export abstract class WebhookSignatureScheme {
  /** Turns a configured secret into the HMAC key, throwing a `TypeError` for a malformed one (checked at startup). */
  key(secret: string): Buffer {
    return textSecretKey(secret);
  }

  /** Checks the request against every key (the configured secrets, as `key()` returned them). */
  abstract verify(request: WebhookSignedRequest, keys: readonly Buffer[]): WebhookSignatureCheck;

  /** The deduplication id when the headers don't carry one (Stripe: the payload's `id`). */
  idFromPayload?(payload: unknown, headers: WebhookHeaders): string | undefined;

  /** Whether any candidate equals `expected`, in constant time for equal lengths. */
  static matches(expected: Buffer, candidates: readonly Buffer[]): boolean {
    let found = false;
    for (const candidate of candidates) {
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        found = true;
      }
    }
    return found;
  }
}
