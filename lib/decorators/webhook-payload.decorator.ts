import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { incoming } from '../utils/verified-webhook.util.js';

/** The verified payload: parsed from the bytes that were signed, never from the framework's parsed body. Takes pipes and a `schema`. */
export const WebhookPayload = createParamDecorator((_data: unknown, context: ExecutionContext) => incoming(context).payload);
