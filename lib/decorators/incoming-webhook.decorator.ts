import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { IncomingWebhook as IncomingWebhookData } from '../interfaces/incoming-webhook.interface.js';
import { incoming } from '../utils/verified-webhook.util.js';

/** The whole verified webhook: `id`, `timestamp`, `payload`, `rawBody`, `processInTransaction()`. */
export const IncomingWebhook = createParamDecorator((_data: unknown, context: ExecutionContext) => incoming(context));
export type IncomingWebhook<T = unknown> = IncomingWebhookData<T>;
