import { createHmac } from 'node:crypto';
import type { WebhookSignedRequest, WebhookSignatureCheck } from '../interfaces/webhook-signature.interface.js';
import { header, missing, malformed, NO_MATCH, HEX_SHA256 } from './signature.util.js';
import { WebhookSignatureScheme } from './webhook-signature.scheme.js';

/** GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`. No timestamp, no signed id. */
export class GitHubScheme extends WebhookSignatureScheme {
  verify({ headers, rawBody }: WebhookSignedRequest, keys: readonly Buffer[]): WebhookSignatureCheck {
    const value = header(headers, 'x-hub-signature-256');
    if (value === undefined) {
      return missing('x-hub-signature-256');
    }
    if (value === null) {
      return malformed('x-hub-signature-256 is repeated');
    }

    const hex = value.startsWith('sha256=') ? value.slice(7) : '';
    if (!HEX_SHA256.test(hex)) {
      return malformed('x-hub-signature-256 is not sha256=<64 hex digits>');
    }

    const candidate = [Buffer.from(hex, 'hex')];
    const delivery = header(headers, 'x-github-delivery');

    for (const key of keys) {
      const expected = createHmac('sha256', key).update(rawBody).digest();
      if (WebhookSignatureScheme.matches(expected, candidate)) {
        return { valid: true, id: typeof delivery === 'string' && delivery !== '' ? delivery : undefined };
      }
    }

    return NO_MATCH;
  }
}
