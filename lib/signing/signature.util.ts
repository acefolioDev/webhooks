import type { WebhookHeaders } from '../interfaces/webhook-receiver-options.interface.js';
import type { WebhookSignatureCheck } from '../interfaces/webhook-signature.interface.js';

/** `header(name)`: a single string value, `undefined` when absent, `null` when repeated. */
export function header(headers: WebhookHeaders, name: string): string | undefined | null {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : null;
  }
  return value;
}

export function missing(name: string): WebhookSignatureCheck {
  return { valid: false, reason: 'missing-header', detail: `no ${name} header` };
}

export function malformed(detail: string): WebhookSignatureCheck {
  return { valid: false, reason: 'malformed-header', detail };
}

export const NO_MATCH: WebhookSignatureCheck = {
  valid: false,
  reason: 'invalid-signature',
  detail: 'no signature matches a configured secret',
};

export const TIMESTAMP = /^\d{1,12}$/;
export const HEX_SHA256 = /^[0-9a-f]{64}$/i;
