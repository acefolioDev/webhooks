import type { WebhookRequest } from '../interfaces/webhook-transport.interface.js';
import { signStandard } from '../signing/standard-webhooks.scheme.js';
import { standardSecretKey } from '../signing/secrets.util.js';

/** A request the in-memory transport received. */
export class SentWebhook {
  constructor(
    readonly request: WebhookRequest,
    /** 1 for the first attempt of its round. */
    readonly attempt: number,
    readonly sentAt: Date,
  ) {}

  get url(): string {
    return this.request.url;
  }
  get type(): string {
    return this.request.type;
  }
  get messageId(): string {
    return this.request.messageId;
  }
  get endpointId(): string {
    return this.request.endpointId;
  }
  get deliveryId(): string {
    return this.request.deliveryId;
  }
  get headers(): Readonly<Record<string, string>> {
    return this.request.headers;
  }
  get body(): string {
    return this.request.body;
  }
  /** The body's `data`. */
  get data(): any {
    return (JSON.parse(this.request.body) as { data: unknown }).data;
  }

  /** Whether a `v1` signature in `webhook-signature` verifies with `secret` (an endpoint's `whsec_…`). */
  isSignedWith(secret: string): boolean {
    const expected = signStandard(
      standardSecretKey(secret),
      this.headers['webhook-id']!,
      Number(this.headers['webhook-timestamp']),
      this.body,
    );

    return this.headers['webhook-signature']!.split(' ').includes(`v1,${expected}`);
  }
}
