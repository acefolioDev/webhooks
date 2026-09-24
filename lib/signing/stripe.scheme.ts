import { createHmac } from 'node:crypto';
import type { WebhookSignedRequest, WebhookSignatureCheck } from '../interfaces/webhook-signature.interface.js';
import { header, missing, malformed, NO_MATCH, TIMESTAMP, HEX_SHA256 } from './signature.util.js';
import { WebhookSignatureScheme } from './webhook-signature.scheme.js';

/** Stripe: `t=…,v1=…[,v1=…]`, hex HMAC-SHA256 of `t.body` keyed with the secret's text. */
export class StripeScheme extends WebhookSignatureScheme {
  constructor(private readonly headerName = 'stripe-signature') {
    super();
  }

  verify({ headers, rawBody }: WebhookSignedRequest, keys: readonly Buffer[]): WebhookSignatureCheck {
    const value = header(headers, this.headerName);
    if (value === undefined) {
      return missing(this.headerName);
    }
    if (value === null) {
      return malformed(`${this.headerName} is repeated`);
    }

    let timestamp: string | undefined;
    const candidates: Buffer[] = [];

    for (const item of value.split(',')) {
      const at = item.indexOf('=');
      if (at < 0) {
        continue;
      }
      const [name, part] = [item.slice(0, at).trim(), item.slice(at + 1).trim()];
      if (name === 't') {
        if (timestamp !== undefined) {
          return malformed(`${this.headerName} has two timestamps`);
        }
        timestamp = part;
      } else if (name === 'v1' && HEX_SHA256.test(part)) {
        candidates.push(Buffer.from(part, 'hex'));
      }
    }

    if (timestamp === undefined || !TIMESTAMP.test(timestamp)) {
      return malformed(`${this.headerName} has no valid t=`);
    }
    if (candidates.length === 0) {
      return { valid: false, reason: 'invalid-signature', detail: `no v1 signature in ${this.headerName}` };
    }

    for (const key of keys) {
      const expected = createHmac('sha256', key).update(`${timestamp}.`).update(rawBody).digest();
      if (WebhookSignatureScheme.matches(expected, candidates)) {
        return { valid: true, timestamp: Number(timestamp) };
      }
    }

    return NO_MATCH;
  }

  override idFromPayload(payload: unknown): string | undefined {
    const id = (payload as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : undefined;
  }
}
