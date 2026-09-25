import { applyDecorators, SetMetadata, UseGuards, UseInterceptors } from '@nestjs/common';
import { VERIFY_WEBHOOK_METADATA } from '../webhooks.constants.js';
import { WebhookSignatureGuard } from '../guards/webhook-signature.guard.js';
import { WebhookInboxInterceptor } from '../interceptors/webhook-inbox.interceptor.js';

/**
 * Verifies the request with the receiver's scheme and secrets on the raw body (create the
 * application with `rawBody: true`), then answers a webhook id this receiver already
 * processed with an empty 2xx instead of running the handler (unless the receiver sets
 * `dedupe: false`). A request that fails verification gets a 401 (a 400 when the body isn't
 * JSON) without the reason; the reason goes to the `verification-failed` event. On a
 * controller or a method; the method's receiver wins.
 *
 * ```ts
 * @Post('payments') @HttpCode(200) @VerifyWebhook('payments')
 * paid(@WebhookPayload() event: PaymentEvent) { ... }
 * ```
 */
export function VerifyWebhook(receiver: string): ClassDecorator & MethodDecorator {
  if (typeof receiver !== 'string' || receiver === '') {
    throw new TypeError('@VerifyWebhook() needs the name of a receiver configured in WebhooksModule `receivers`');
  }
  return applyDecorators(
    SetMetadata(VERIFY_WEBHOOK_METADATA, receiver),
    UseGuards(WebhookSignatureGuard),
    UseInterceptors(WebhookInboxInterceptor),
  ) as ClassDecorator & MethodDecorator;
}
