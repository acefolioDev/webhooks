import { BadRequestException, Injectable, Logger, UnauthorizedException, UnsupportedMediaTypeException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WebhookVerificationError } from '../errors/webhook-verification.error.js';
import { WebhookVerifier } from '../services/webhook-verifier.service.js';
import { VERIFY_WEBHOOK_METADATA, VERIFIED } from '../webhooks.constants.js';
import type { ReceivedWebhookRequest } from '../interfaces/received-webhook-request.interface.js';

const JSON_OR_FORM = /^application\/(json|x-www-form-urlencoded)\s*(;|$)/i;

/** Runs `WebhookVerifier.verify()` on the raw body and answers failures (see `@VerifyWebhook()`). */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger('WebhooksModule');

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: WebhookVerifier,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      throw new Error(`@VerifyWebhook() is for HTTP routes, and ${context.getClass().name}.${context.getHandler().name} runs over ${context.getType()}`);
    }

    const receiver = this.reflector.getAllAndOverride<string>(VERIFY_WEBHOOK_METADATA, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<ReceivedWebhookRequest>();

    // On the controller and the method: verified once.
    if (request[VERIFIED]) {
      return true;
    }

    try {
      request[VERIFIED] = this.verifier.verify(receiver, { headers: request.headers, rawBody: this.rawBody(request) });
    } catch (error) {
      throw toHttpException(error);
    }

    return true;
  }

  private rawBody(request: ReceivedWebhookRequest): Buffer {
    if (Buffer.isBuffer(request.rawBody)) {
      return request.rawBody;
    }

    const length = request.headers['content-length'];
    const type = request.headers['content-type'];
    if ((length === undefined || length === '0') && request.headers['transfer-encoding'] === undefined) {
      return Buffer.alloc(0);
    }

    if (typeof type !== 'string' || !JSON_OR_FORM.test(type)) {
      throw new UnsupportedMediaTypeException('Webhooks are accepted as application/json');
    }

    const error = new Error(
      '@VerifyWebhook(): the request has no raw body. Create the application with `NestFactory.create(AppModule, { rawBody: true })` ' +
        '(Express and Fastify), so signatures are checked on the bytes that were signed.',
    );
    this.logger.error(error.message);
    throw error;
  }
}

/** Maps the verifier's error to Nest's exceptions, without the reason (kept for the event and the cause). */
function toHttpException(error: unknown): unknown {
  if (!(error instanceof WebhookVerificationError)) {
    return error;
  }
  return error.status === 400
    ? new BadRequestException('Webhook payload is not valid JSON', { cause: error })
    : new UnauthorizedException('Webhook signature verification failed', { cause: error });
}
