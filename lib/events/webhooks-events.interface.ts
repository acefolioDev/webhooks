import type { WebhookVerificationFailure } from '../errors/webhook-verification.error.js';
import type { WebhookDelivery, WebhookDeliveryFailureReason } from '../interfaces/webhook-delivery.interface.js';
import type { WebhookEndpointDisabledReason } from '../interfaces/webhook-endpoint.interface.js';

/** Channel `nestjs:webhooks:delivered`: an endpoint answered 2xx. */
export interface WebhooksDeliveredEvent {
  type: 'delivered';
  delivery: WebhookDelivery;
  statusCode: number;
  /** 1-based, within the delivery's round. */
  attempt: number;
  durationMs: number;
}

/** Channel `nestjs:webhooks:retry-scheduled`: an attempt failed and the delivery will be retried after `delayMs`. */
export interface WebhooksRetryScheduledEvent {
  type: 'retry-scheduled';
  delivery: WebhookDelivery;
  error: unknown;
  statusCode: number | null;
  attempt: number;
  delayMs: number;
}

/** Channel `nestjs:webhooks:delivery-failed`: the delivery failed for good (see `reason`). */
export interface WebhooksDeliveryFailedEvent {
  type: 'delivery-failed';
  delivery: WebhookDelivery;
  error: unknown;
  statusCode: number | null;
  attempt: number;
  reason: WebhookDeliveryFailureReason;
}

/** Channel `nestjs:webhooks:endpoint-disabled`: the worker disabled an endpoint. Tell its owner. */
export interface WebhooksEndpointDisabledEvent {
  type: 'endpoint-disabled';
  endpointId: string;
  tenant: string | null;
  reason: Exclude<WebhookEndpointDisabledReason, 'manual'>;
}

/**
 * Channel `nestjs:webhooks:destination-blocked`: a delivery was refused because its URL is
 * or resolves to a blocked address. A customer-controlled URL pointing inside your network
 * is worth a security alert.
 */
export interface WebhooksDestinationBlockedEvent {
  type: 'destination-blocked';
  endpointId: string;
  tenant: string | null;
  reason: string;
  address: string | undefined;
}

/** Channel `nestjs:webhooks:verification-failed`: an incoming webhook was refused. */
export interface WebhooksVerificationFailedEvent {
  type: 'verification-failed';
  receiver: string;
  reason: WebhookVerificationFailure;
}

export type WebhooksEvent =
  | WebhooksDeliveredEvent
  | WebhooksRetryScheduledEvent
  | WebhooksDeliveryFailedEvent
  | WebhooksEndpointDisabledEvent
  | WebhooksDestinationBlockedEvent
  | WebhooksVerificationFailedEvent;
