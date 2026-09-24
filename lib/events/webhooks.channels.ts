import { channel, type Channel } from 'node:diagnostics_channel';
import type { WebhooksEvent } from './webhooks-events.interface.js';

export const channels: Record<WebhooksEvent['type'], Channel> = {
  delivered: channel('nestjs:webhooks:delivered'),
  'retry-scheduled': channel('nestjs:webhooks:retry-scheduled'),
  'delivery-failed': channel('nestjs:webhooks:delivery-failed'),
  'endpoint-disabled': channel('nestjs:webhooks:endpoint-disabled'),
  'destination-blocked': channel('nestjs:webhooks:destination-blocked'),
  'verification-failed': channel('nestjs:webhooks:verification-failed'),
};
