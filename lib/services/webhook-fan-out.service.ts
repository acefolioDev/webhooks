import { Injectable } from '@nestjs/common';
import { NonRetryableMessageError, OnOutboxMessage } from '@nestjs/outbox';
import type { WebhookDelivery } from '../interfaces/webhook-delivery.interface.js';
import type { WebhookMessage } from '../interfaces/webhook-message.interface.js';
import { WebhooksStorage } from '../storage/webhooks.storage.js';
import { WebhookWorker } from './webhook-worker.service.js';
import { WEBHOOKS_OUTBOX_TOPIC } from '../webhooks.constants.js';
import { prefixedId } from '../utils/uuid.util.js';

/**
 * The outbox handler that turns a committed message into deliveries: one per enabled
 * endpoint of the message's tenant subscribed to its type, created before the message was.
 *
 * It runs after the commit, in the outbox relay, with the outbox's retries: a store that is
 * down fails the attempt and the relay tries again. `createDeliveries()` is idempotent (one
 * delivery per message and endpoint), so a redelivery creates only what is missing, and the
 * handler needs no inbox record of its own (`inbox: false`).
 */
@Injectable()
export class WebhookFanOut {
  constructor(
    private readonly storage: WebhooksStorage,
    private readonly worker: WebhookWorker,
  ) {}

  @OnOutboxMessage(WEBHOOKS_OUTBOX_TOPIC, { consumer: 'nestjs-webhooks', inbox: false })
  async fanOut(message: WebhookMessage): Promise<void> {
    if (!isMessage(message)) {
      throw new NonRetryableMessageError(`Not a webhook message: ${JSON.stringify(message)?.slice(0, 200)}`);
    }

    const endpoints = await this.storage.endpoints.findSubscribedEndpoints(message.tenant, message.type);
    const deliveries: WebhookDelivery[] = endpoints
      // An endpoint receives what was dispatched after it existed, even when the relay runs late.
      .filter((endpoint) => endpoint.tenant === message.tenant && endpoint.createdAt <= message.createdAt)
      .map((endpoint) => ({
        id: prefixedId('dlv'),
        messageId: message.id,
        endpointId: endpoint.id,
        tenant: message.tenant,
        type: message.type,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: message.createdAt,
        lastAttemptAt: null,
        lastStatusCode: null,
        lastError: null,
        failureReason: null,
        createdAt: message.createdAt,
        completedAt: null,
      }));

    if (deliveries.length === 0) {
      return;
    }

    const created = await this.storage.deliveries.createDeliveries(message, deliveries);
    if (created > 0) {
      this.worker.notify();
    }
  }
}

function isMessage(value: unknown): value is WebhookMessage {
  const m = value as WebhookMessage | null;
  return (
    typeof m?.id === 'string' &&
    typeof m.type === 'string' &&
    typeof m.body === 'string' &&
    typeof m.createdAt === 'number' &&
    (m.tenant === null || typeof m.tenant === 'string')
  );
}
