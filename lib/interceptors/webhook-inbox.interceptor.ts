import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { defer, lastValueFrom, map, type Observable } from 'rxjs';
import { WebhookVerifier } from '../services/webhook-verifier.service.js';
import { VERIFIED, DEDUPED } from '../webhooks.constants.js';
import type { ReceivedWebhookRequest } from '../interfaces/received-webhook-request.interface.js';

/** Skips a webhook id the receiver already processed, and records it after the handler succeeds (`OutboxInbox.process()`). */
@Injectable()
export class WebhookInboxInterceptor implements NestInterceptor {
  constructor(private readonly verifier: WebhookVerifier) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ReceivedWebhookRequest>();
    const webhook = request[VERIFIED];
    const receiver = webhook && this.verifier.receiverConfig(webhook.receiver);

    // On the controller and the method: deduplicated once (a nested process() of the same id would wait for itself).
    if (!webhook || !receiver?.dedupe || request[DEDUPED]) {
      return next.handle();
    }

    request[DEDUPED] = true;
    const inbox = this.verifier.requireInbox();
    return defer(() => inbox.process(receiver.consumer, webhook.id, () => lastValueFrom(next.handle(), { defaultValue: undefined }))).pipe(
      map((result) => (result.duplicate ? undefined : result.result)),
    );
  }
}
