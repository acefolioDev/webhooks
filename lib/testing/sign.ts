import { createHmac, randomUUID } from 'node:crypto';
import { signStandard } from '../signing/standard-webhooks.scheme.js';
import { standardSecretKey } from '../signing/secrets.util.js';

export interface SignWebhookOptions {
  /** The receiver's scheme. */
  scheme: 'standard' | 'stripe' | 'github';
  /** The secret the receiver is configured with. */
  secret: string;
  /** An object (sent as JSON) or the exact body text. */
  payload: unknown;
  /** `webhook-id` (standard) or `x-github-delivery` (github). Default: a random id. Stripe's id is the payload's `id`. */
  id?: string;
  /** The signed time. Default: now. Move it to test the tolerance. */
  timestamp?: Date;
  /** Stripe-like schemes under another header name. Default `stripe-signature`. */
  header?: string;
}

/** A body and headers as the sender would send them. */
export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

/**
 * Signs a test payload the way PayFast (Standard Webhooks), Stripe or GitHub would, for
 * requests to your `@VerifyWebhook()` routes:
 *
 * ```ts
 * const { body, headers } = signWebhook({ scheme: 'standard', secret, payload: { type: 'payment.succeeded', data } });
 * await request(app.getHttpServer()).post('/webhooks/payfast').set(headers).send(body).expect(200);
 * ```
 */
export function signWebhook({ scheme, secret, payload, id, timestamp = new Date(), header }: SignWebhookOptions): SignedWebhook {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const seconds = Math.floor(timestamp.getTime() / 1000);
  const json = { 'content-type': 'application/json' };

  switch (scheme) {
    case 'standard': {
      const webhookId = id ?? `msg_${randomUUID().replaceAll('-', '')}`;
      return {
        body,
        headers: {
          ...json,
          'webhook-id': webhookId,
          'webhook-timestamp': String(seconds),
          'webhook-signature': `v1,${signStandard(standardSecretKey(secret), webhookId, seconds, body)}`,
        },
      };
    }
    case 'stripe': {
      const signature = createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex');
      return { body, headers: { ...json, [(header ?? 'stripe-signature').toLowerCase()]: `t=${seconds},v1=${signature}` } };
    }
    case 'github': {
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      return { body, headers: { ...json, 'x-hub-signature-256': `sha256=${signature}`, 'x-github-delivery': id ?? randomUUID() } };
    }
    default:
      throw new TypeError(`signWebhook(): unknown scheme ${JSON.stringify(scheme)}`);
  }
}
