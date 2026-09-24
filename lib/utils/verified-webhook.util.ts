import type { ExecutionContext } from '@nestjs/common';
import type { IncomingWebhook as IncomingWebhookData } from '../interfaces/incoming-webhook.interface.js';
import { VERIFIED } from '../webhooks.constants.js';
import type { ReceivedWebhookRequest } from '../interfaces/received-webhook-request.interface.js';

export function incoming(context: ExecutionContext): IncomingWebhookData {
  const webhook = context.switchToHttp().getRequest<ReceivedWebhookRequest>()[VERIFIED];
  if (!webhook) {
    throw new Error('@WebhookPayload() and @IncomingWebhook() need @VerifyWebhook(receiver) on the route or its controller');
  }
  return webhook;
}
