import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { WebhookEncryptionOptions } from '../interfaces/webhooks-module-options.interface.js';

const PREFIX = 'sealed.v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const HKDF_INFO = 'nestjs-webhooks:v1';
const MIN_SECRET_LENGTH = 32;

interface DerivedKey {
  id: string;
  key: Buffer;
}

/**
 * Seals endpoint secrets before they reach the store, and opens them when the worker signs.
 * Without `encryption`, secrets are stored as they are (`whsec_…`).
 */
export interface SecretCodec {
  seal(endpointId: string, secret: string): string;
  open(endpointId: string, stored: string): string;
}

export const plaintextSecrets: SecretCodec = {
  seal: (_endpointId, secret) => secret,
  open(_endpointId, stored) {
    if (stored.startsWith(`${PREFIX}.`)) {
      throw new Error('This endpoint secret is encrypted, and WebhooksModule has no `encryption` keys to open it');
    }
    return stored;
  },
};

/**
 * AES-256-GCM with the endpoint id as additional data, so a sealed secret copied to another
 * endpoint's row fails to open instead of signing there. The first key seals, every key
 * opens (rotation); key ids are a truncated hash of the key. A plaintext secret still opens
 * (endpoints created before encryption was turned on) and is sealed at its next rotation.
 */
export class SecretCipher implements SecretCodec {
  private readonly keys: DerivedKey[];

  constructor(options: WebhookEncryptionOptions) {
    const list: unknown = options?.keys;
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError('WebhooksModule: `encryption.keys` must list at least one key (newest first).');
    }
    this.keys = list.map(deriveKey);
  }

  seal(endpointId: string, secret: string): string {
    const { id, key } = this.keys[0]!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(endpointId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [PREFIX, id, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  open(endpointId: string, stored: string): string {
    if (!stored.startsWith(`${PREFIX}.`)) {
      return stored;
    }

    const [, , id, iv, ciphertext, tag, ...rest] = stored.split('.');
    if (rest.length > 0 || !tag) {
      throw new Error('Malformed sealed endpoint secret');
    }

    const entry = this.keys.find((key) => key.id === id);
    if (!entry) {
      throw new Error(`Endpoint secret sealed with an unknown key (id "${id}"): add that key to encryption.keys`);
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, entry.key, Buffer.from(iv!, 'base64url'));
      decipher.setAAD(Buffer.from(endpointId, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext!, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`Endpoint secret of ${endpointId} failed authentication (tampered, or sealed for another endpoint)`);
    }
  }
}

function deriveKey(material: Buffer | string, index: number): DerivedKey {
  const option = `encryption.keys[${index}]`;
  let key: Buffer;

  if (Buffer.isBuffer(material)) {
    if (material.length !== 32) {
      throw new TypeError(`WebhooksModule: \`${option}\` is a Buffer of ${material.length} bytes; it must be 32 bytes.`);
    }
    key = material;
  } else if (typeof material === 'string' && material.trim() !== material) {
    throw new TypeError(
      `WebhooksModule: \`${option}\` starts or ends with whitespace, so it isn't the key you meant. ` +
        "Trim the keys, for example `split(',').map((key) => key.trim())`.",
    );
  } else if (typeof material === 'string' && material.length >= MIN_SECRET_LENGTH) {
    key = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), HKDF_INFO, 32));
  } else {
    throw new TypeError(
      `WebhooksModule: \`${option}\` must be 32 random bytes, or a random string of at least ${MIN_SECRET_LENGTH} ` +
        'characters (for example `openssl rand -base64 32`), not a password.',
    );
  }

  return { id: createHash('sha256').update(key).digest('base64url').slice(0, 8), key };
}
