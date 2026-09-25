/**
 * Endpoint secrets at rest across the life of an app: turning encryption on over plaintext
 * secrets, rotating the encryption key, losing a key, and a tampered row. Two apps share one
 * store, as two deployments share a database.
 */
import { InMemoryWebhookStore } from '../lib/index.js';
import { sendingApp, useStore } from './helpers.js';

const KEY_A = 'a'.repeat(32);
const KEY_B = Buffer.alloc(32, 0xb);

const deploy = (store: InMemoryWebhookStore, keys?: (string | Buffer)[]) =>
  sendingApp(keys ? { encryption: { keys } } : {}, { override: useStore(store) });

const stored = (store: InMemoryWebhookStore, id: string) => store.getEndpoint(id)!.secrets.map((s) => s.secret);
const keyId = (sealed: string) => sealed.split('.')[2];

describe('endpoint secrets at rest', () => {
  it('opens plaintext secrets after encryption is turned on, and seals them at the next rotation', async () => {
    const store = new InMemoryWebhookStore();
    const before = await deploy(store);
    const endpoint = await before.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    expect(stored(store, endpoint.id)).toEqual([endpoint.secret]);
    await before.close();

    const after = await deploy(store, [KEY_A]);
    expect(await after.endpoints.getSecret(endpoint.id)).toBe(endpoint.secret);
    await after.transaction((tx) => after.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await after.flush();
    expect(after.transport.single().isSignedWith(endpoint.secret)).toBe(true);

    const next = await after.endpoints.rotateSecret(endpoint.id, { overlap: '1h' });
    const [sealed, old] = stored(store, endpoint.id);
    expect(sealed).toMatch(/^sealed\.v1\./);
    expect(sealed).not.toContain(next.slice(6));
    expect(old).toBe(endpoint.secret); // the outgoing one stays as it was until it expires
    expect(await after.endpoints.getSecret(endpoint.id)).toBe(next);
    await after.close();
  });

  it('seals with the first key and opens with any listed one, so the key can rotate', async () => {
    const store = new InMemoryWebhookStore();
    const withA = await deploy(store, [KEY_A]);
    const old = await withA.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await withA.close();

    const withBA = await deploy(store, [KEY_B, KEY_A]);
    const created = await withBA.endpoints.create({ url: 'https://b.example/', eventTypes: ['*'] });
    expect(await withBA.endpoints.getSecret(old.id)).toBe(old.secret);
    expect(await withBA.endpoints.getSecret(created.id)).toBe(created.secret);
    expect(keyId(stored(store, created.id)[0]!)).not.toBe(keyId(stored(store, old.id)[0]!));

    // Both sign what they send.
    await withBA.transaction((tx) => withBA.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await withBA.flush();
    expect(withBA.transport.single({ endpointId: old.id }).isSignedWith(old.secret)).toBe(true);
    expect(withBA.transport.single({ endpointId: created.id }).isSignedWith(created.secret)).toBe(true);
    await withBA.close();

    // Dropping key A too early: what it sealed no longer opens, and the error says which key is missing.
    const withB = await deploy(store, [KEY_B]);
    await expect(withB.endpoints.getSecret(old.id)).rejects.toThrow(`Endpoint secret sealed with an unknown key (id "${keyId(stored(store, old.id)[0]!)}")`);
    expect(await withB.endpoints.getSecret(created.id)).toBe(created.secret);
    await withB.close();
  });

  it('seals the same secret differently each time', async () => {
    const store = new InMemoryWebhookStore();
    const t = await deploy(store, [KEY_A]);
    const secret = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
    const a = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'], secret });
    await t.endpoints.rotateSecret(a.id, { secret, overlap: '1h' });
    const [first, second] = stored(store, a.id);
    expect(first).not.toBe(second);
    await t.close();
  });

  it('says so when a sealed secret meets an app without encryption keys', async () => {
    const store = new InMemoryWebhookStore();
    const encrypted = await deploy(store, [KEY_A]);
    const endpoint = await encrypted.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await encrypted.close();

    const plain = await deploy(store);
    await expect(plain.endpoints.getSecret(endpoint.id)).rejects.toThrow('This endpoint secret is encrypted, and WebhooksModule has no `encryption` keys to open it');
    await plain.close();
  });

  it('refuses a tampered or malformed sealed secret', async () => {
    const store = new InMemoryWebhookStore();
    const t = await deploy(store, [KEY_A]);
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    const [sealed] = stored(store, endpoint.id);
    const parts = sealed!.split('.');
    const flipped = Buffer.from(parts[4]!, 'base64url');
    flipped[0]! ^= 1;
    const replace = (secret: string) => store.addEndpointSecret(endpoint.id, { secret, createdAt: 0, expiresAt: null }, 0, Date.now());

    replace([...parts.slice(0, 4), flipped.toString('base64url'), parts[5]].join('.'));
    await expect(t.endpoints.getSecret(endpoint.id)).rejects.toThrow(`Endpoint secret of ${endpoint.id} failed authentication`);
    replace(`${sealed}.extra`);
    await expect(t.endpoints.getSecret(endpoint.id)).rejects.toThrow('Malformed sealed endpoint secret');
    replace(parts.slice(0, 5).join('.'));
    await expect(t.endpoints.getSecret(endpoint.id)).rejects.toThrow('Malformed sealed endpoint secret');
    await t.close();
  });
});
