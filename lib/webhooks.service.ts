import { Inject, Injectable, Optional } from '@nestjs/common';
import { Outbox, type OutboxMessage } from '@nestjs/outbox';
import type { ResolvedWebhooksConfig } from './interfaces/resolved-webhooks-config.interface.js';
import { EVENT_TYPE, WEBHOOKS_CONFIG } from './webhooks.constants.js';
import type { NewWebhookMessage, WebhookMessage } from './interfaces/webhook-message.interface.js';
import type { Awaitable } from './interfaces/awaitable.interface.js';
import { prefixedId } from './utils/uuid.util.js';
import { WEBHOOKS_OUTBOX_TOPIC } from './webhooks.constants.js';

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TENANT_LENGTH = 256;

/**
 * Sends webhooks. `Tx` is your data layer's transaction handle, as for `Outbox<Tx>`:
 * inject `Webhooks<Transaction>` (Drizzle's `tx`), `Webhooks<EntityManager>`...
 */
@Injectable()
export class Webhooks<Tx = unknown> {
  constructor(
    @Inject(WEBHOOKS_CONFIG) private readonly config: ResolvedWebhooksConfig,
    @Optional() private readonly outbox?: Outbox,
  ) {}

  /**
   * Adds the message(s) to the outbox through `tx`, your open transaction: nothing is sent
   * unless it commits. After the commit, the fan-out creates one delivery per subscribed
   * endpoint of the message's tenant, and the worker signs and sends each.
   *
   * With a synchronous outbox store the result is not a promise; with an async store,
   * await it before the transaction commits, like any other query.
   */
  dispatch<D>(tx: Tx, message: NewWebhookMessage<D>): Awaitable<WebhookMessage>;
  dispatch<D>(tx: Tx, messages: readonly NewWebhookMessage<D>[]): Awaitable<WebhookMessage[]>;
  dispatch<D>(tx: Tx, input: NewWebhookMessage<D> | readonly NewWebhookMessage<D>[]): Awaitable<WebhookMessage | WebhookMessage[]> {
    const outbox = this.requireOutbox();
    const now = Date.now();
    const batch = Array.isArray(input);
    const messages = (batch ? (input as readonly NewWebhookMessage<D>[]) : [input as NewWebhookMessage<D>]).map((m) => this.build(m, now));

    const added = outbox.add(
      tx,
      messages.map((message) => ({ topic: WEBHOOKS_OUTBOX_TOPIC, id: message.id, payload: message })),
    );

    const output = batch ? messages : messages[0]!;
    return isPromise<OutboxMessage[]>(added) ? added.then(() => output) : output;
  }

  /** Run the outbox relay now (and so the fan-out) instead of at its next poll. Call it after the commit. */
  notify(): void {
    this.outbox?.notify();
  }

  private build<D>(input: NewWebhookMessage<D>, now: number): WebhookMessage {
    const { type, tenant = null, id } = input ?? ({} as NewWebhookMessage<D>);
    if (typeof type !== 'string' || !EVENT_TYPE.test(type)) {
      throw new TypeError(`Webhooks.dispatch(): ${JSON.stringify(type)} is not a message type such as "order.shipped"`);
    }

    if (this.config.eventTypes && !this.config.eventTypes.has(type)) {
      throw new TypeError(
        `Webhooks.dispatch(): "${type}" is not in the eventTypes option (${[...this.config.eventTypes].join(', ')}). Add it there first.`,
      );
    }

    if (tenant !== null && (typeof tenant !== 'string' || tenant === '' || tenant.length > MAX_TENANT_LENGTH)) {
      throw new TypeError(`Webhooks.dispatch(): tenant must be null or a non-empty string of at most ${MAX_TENANT_LENGTH} characters`);
    }

    if (id !== undefined && (typeof id !== 'string' || !MESSAGE_ID.test(id))) {
      throw new TypeError('Webhooks.dispatch(): id must be letters, digits, "_" and "-", at most 128 (no ".")');
    }

    // Serialized once, here: every endpoint and every attempt gets these exact bytes.
    const body = JSON.stringify({ type, timestamp: new Date(now).toISOString(), data: input.data });
    if (input.data === undefined || body === undefined) {
      throw new TypeError(`Webhooks.dispatch(): the data of "${type}" must be JSON-serializable (got undefined)`);
    }

    return { id: id ?? prefixedId('msg'), type, tenant, body, createdAt: now };
  }

  private requireOutbox(): Outbox {
    if (!this.outbox) {
      throw new Error('Webhooks.dispatch() needs @nestjs/outbox: import OutboxModule.forRoot() in the application module.');
    }
    return this.outbox;
  }
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}
