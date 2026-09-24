import { Inject, Injectable, Optional } from '@nestjs/common';
import { OutboxInbox } from '@nestjs/outbox';
import type { CompiledReceiver, ResolvedWebhooksConfig } from '../interfaces/resolved-webhooks-config.interface.js';
import { WEBHOOKS_CONFIG } from '../webhooks.constants.js';
import { WebhookVerificationError, type WebhookVerificationFailure } from '../errors/webhook-verification.error.js';
import { WebhooksEvents } from '../events/webhooks-events.service.js';
import type { WebhookHeaders } from '../interfaces/webhook-receiver-options.interface.js';
import type { IncomingWebhook, WebhookVerifyRequest } from '../interfaces/incoming-webhook.interface.js';

const MAX_ID_LENGTH = 256;

/**
 * Verifies incoming webhooks against the configured `receivers`. `@VerifyWebhook()` uses
 * it; call it yourself where there is no HTTP route (a queue that stored the raw request).
 */
@Injectable()
export class WebhookVerifier {
  constructor(
    @Inject(WEBHOOKS_CONFIG) private readonly config: ResolvedWebhooksConfig,
    private readonly events: WebhooksEvents,
    @Optional() private readonly inbox?: OutboxInbox,
  ) {}

  get receivers(): string[] {
    return [...this.config.receivers.keys()];
  }

  /**
   * Checks the signature with every configured secret, the timestamp against `tolerance`,
   * and parses the body as JSON. Throws `WebhookVerificationError` (status 401, or 400 for
   * a body that isn't JSON), and an `Error` for a receiver that isn't configured.
   */
  verify<T = unknown>(receiver: string, request: WebhookVerifyRequest): IncomingWebhook<T> {
    const config = this.config.receivers.get(receiver);
    if (!config) {
      throw new Error(`Unknown webhook receiver "${receiver}". Configured: ${this.receivers.join(', ') || 'none'} (WebhooksModule receivers)`);
    }

    const headers = lowerCase(request.headers);
    const rawBody = typeof request.rawBody === 'string' ? Buffer.from(request.rawBody, 'utf8') : request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new TypeError('WebhookVerifier.verify(): rawBody must be the body as received, a Buffer or a string');
    }

    const check = config.scheme.verify({ headers, rawBody }, config.keys);
    if (!check.valid) {
      this.fail(config, check.reason, check.detail);
    }
    if (check.timestamp !== undefined) {
      const skewMs = Math.abs(Date.now() - check.timestamp * 1000);
      if (!Number.isFinite(skewMs) || skewMs > config.toleranceMs) {
        this.fail(config, 'timestamp-out-of-tolerance', `the signed timestamp is ${Math.round(skewMs / 1000)}s from now`);
      }
    }

    let payload: unknown;
    try {
      payload = rawBody.length === 0 ? undefined : JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.fail(config, 'invalid-payload', 'the body is not JSON');
    }

    const id = config.id?.(payload, headers) ?? check.id ?? config.scheme.idFromPayload?.(payload, headers);
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
      this.fail(config, 'missing-header', 'no webhook id (a header or the payload id the scheme reads)');
    }

    return {
      receiver,
      id,
      timestamp: check.timestamp === undefined ? null : new Date(check.timestamp * 1000),
      payload: payload as T,
      rawBody,
      processInTransaction: (tx, work) => this.requireInbox().processInTransaction(tx, config.consumer, id, work),
    };
  }

  /** @internal The inbox consumer and dedupe setting of a receiver, for the interceptor. */
  receiverConfig(receiver: string): CompiledReceiver | undefined {
    return this.config.receivers.get(receiver);
  }

  /** @internal */
  requireInbox(): OutboxInbox {
    if (!this.inbox) {
      throw new Error(
        'Webhook deduplication needs @nestjs/outbox: import OutboxModule.forRoot() (a receive-only service can set relay: { enabled: false }).',
      );
    }
    return this.inbox;
  }

  private fail(config: CompiledReceiver, reason: WebhookVerificationFailure, detail: string): never {
    try {
      this.events.emit({ type: 'verification-failed', receiver: config.name, reason });
    } catch {
      // A subscriber's error is not the sender's.
    }
    throw new WebhookVerificationError(config.name, reason, detail);
  }
}

function lowerCase(headers: WebhookHeaders | Headers): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  if (typeof (headers as Headers)?.forEach === 'function' && typeof (headers as Headers).get === 'function') {
    (headers as Headers).forEach((value, name) => (out[name.toLowerCase()] = value));
    return out;
  }

  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}
