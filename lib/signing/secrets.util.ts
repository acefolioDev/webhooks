import { randomBytes } from 'node:crypto';

const PREFIX = 'whsec_';
/** Standard Webhooks: "random, between 24 bytes (192 bits) and 64 bytes (512 bits)". */
const MIN_BYTES = 24;
const MAX_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A new endpoint secret: `whsec_` and 32 random bytes in base64. */
export function generateSecret(): string {
  return PREFIX + randomBytes(32).toString('base64');
}

/**
 * The HMAC key of a Standard Webhooks secret: the base64 after `whsec_` (the prefix is
 * optional, as in the reference libraries). Throws a `TypeError` saying what is wrong.
 */
export function standardSecretKey(secret: string): Buffer {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('the secret is empty');
  }
  if (secret.trim() !== secret) {
    throw new TypeError('the secret starts or ends with whitespace (a stray newline from an environment file?)');
  }

  const encoded = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) {
    throw new TypeError('a Standard Webhooks secret is `whsec_` followed by base64');
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length < MIN_BYTES || key.length > MAX_BYTES) {
    throw new TypeError(`a Standard Webhooks secret holds ${MIN_BYTES} to ${MAX_BYTES} bytes (this one holds ${key.length})`);
  }
  return key;
}

/** A shared secret used as text (Stripe, GitHub): non-empty, no surrounding whitespace. */
export function textSecretKey(secret: string): Buffer {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('the secret is empty');
  }
  if (secret.trim() !== secret) {
    throw new TypeError('the secret starts or ends with whitespace (a stray newline from an environment file?)');
  }
  return Buffer.from(secret, 'utf8');
}
