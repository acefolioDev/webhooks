import type { OutboxInboxResult } from '@nestjs/outbox';
import type { WebhookHeaders } from './webhook-receiver-options.interface.js';
import type { Awaitable } from './awaitable.interface.js';

/** A webhook that passed verification: the payload parsed from the exact bytes that were signed. */
export interface IncomingWebhook<T = unknown> {
  /** The receiver's name, as in `@VerifyWebhook(name)`. */
  readonly receiver: string;
  /** The sender's id for it: `webhook-id`, Stripe's event id, GitHub's delivery id. What deduplication keys on. */
  readonly id: string;
  /** The signed timestamp, or null for a scheme that signs none (GitHub). */
  readonly timestamp: Date | null;
  readonly payload: T;
  readonly rawBody: Buffer;
  /**
   * Exactly-once effects: records this webhook's id in the receiver's inbox through `tx`
   * and runs `work` only if it is new, so the record commits with `work`'s writes. A
   * redelivery, even one racing this in another instance, gets `{ duplicate: true }`.
   */
  processInTransaction<Tx, R>(tx: Tx, work: () => R): Awaitable<OutboxInboxResult<Awaited<R>>>;
}

/** What `verify()` checks: the headers (any case) and the body exactly as received. */
export interface WebhookVerifyRequest {
  headers: WebhookHeaders | Headers;
  rawBody: Buffer | string;
}
