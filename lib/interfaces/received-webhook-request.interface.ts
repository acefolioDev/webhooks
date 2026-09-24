import type { IncomingWebhook as IncomingWebhookData } from './incoming-webhook.interface.js';
import { VERIFIED, DEDUPED } from '../webhooks.constants.js';

export type ReceivedWebhookRequest = {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: unknown;
  [VERIFIED]?: IncomingWebhookData;
  [DEDUPED]?: boolean;
};
