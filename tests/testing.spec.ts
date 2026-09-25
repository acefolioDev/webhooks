/**
 * What tests of an app use: `InMemoryWebhookTransport` and its `SentWebhook` records,
 * `signWebhook()` from `@nestjs/webhooks/testing`, and the store contracts, which must
 * catch a store that breaks the rule a case names.
 */
import { signStandard } from '../lib/signing/standard-webhooks.scheme.js';
import { standardSecretKey } from '../lib/signing/secrets.util.js';
import { signWebhook, webhookDeliveryStoreContract, webhookEndpointStoreContract, type WebhookStoreContractCase } from '../lib/testing/index.js';
import {
  InMemoryWebhookStore,
  InMemoryWebhookTransport,
  SentWebhook,
  type WebhookClaimRequest,
  type WebhookDeliveryFilter,
  type WebhookDeliveryUpdate,
  type WebhookEndpointPatch,
  type WebhookRequest,
} from '../lib/index.js';

const SECRET = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;

function signedRequest(overrides: Partial<WebhookRequest> = {}): WebhookRequest {
  const body = overrides.body ?? JSON.stringify({ type: 'order.shipped', timestamp: '2026-01-01T00:00:00.000Z', data: { orderId: 'o-1' } });
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    url: 'https://a.example/hooks',
    headers: {
      'webhook-id': 'msg_1',
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signStandard(standardSecretKey(SECRET), 'msg_1', timestamp, body)}`,
    },
    body,
    endpointId: 'ep_1',
    deliveryId: 'dlv_1',
    messageId: 'msg_1',
    type: 'order.shipped',
    ...overrides,
  };
}

const options = (attempt = 1) => ({ signal: new AbortController().signal, attempt });

describe('InMemoryWebhookTransport', () => {
  it('answers 200 with no headers and an empty body by default, and fills in what a response leaves out', async () => {
    const transport = new InMemoryWebhookTransport();
    expect(await transport.send(signedRequest(), options())).toEqual({ statusCode: 200, headers: {}, body: '' });
    transport.respondWith({ body: 'accepted' });
    expect(await transport.send(signedRequest(), options())).toEqual({ statusCode: 200, headers: {}, body: 'accepted' });
    transport.respondWith(async (_request, attempt) => ({ statusCode: attempt === 1 ? 503 : 202, headers: { 'retry-after': '1' } }));
    expect(await transport.send(signedRequest(), options(1))).toEqual({ statusCode: 503, headers: { 'retry-after': '1' }, body: '' });
    expect(await transport.send(signedRequest(), options(2))).toMatchObject({ statusCode: 202 });
  });

  it('records a request even when the responder throws, and throws for an aborted signal without recording', async () => {
    const transport = new InMemoryWebhookTransport().respondWith(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(transport.send(signedRequest(), options())).rejects.toThrow('ECONNREFUSED');
    expect(transport.sent).toHaveLength(1);

    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    await expect(transport.send(signedRequest(), { signal: controller.signal, attempt: 1 })).rejects.toThrow('timed out');
    expect(transport.sent).toHaveLength(1);
  });

  it('filters by type, endpoint, message, URL string or pattern, and a function; clear() forgets', async () => {
    const transport = new InMemoryWebhookTransport();
    await transport.send(signedRequest(), options());
    await transport.send(signedRequest({ type: 'order.cancelled', url: 'https://b.example/x', endpointId: 'ep_2', messageId: 'msg_2' }), options());
    await transport.send(signedRequest({ type: 'order.cancelled', endpointId: 'ep_1', messageId: 'msg_3' }), options(3));

    expect(transport.filter().map((s) => s.messageId)).toEqual(['msg_1', 'msg_2', 'msg_3']);
    expect(transport.filter({ type: 'order.cancelled' }).map((s) => s.messageId)).toEqual(['msg_2', 'msg_3']);
    expect(transport.filter({ type: 'order.cancelled', endpointId: 'ep_1' }).map((s) => s.messageId)).toEqual(['msg_3']);
    expect(transport.filter({ url: 'https://b.example/x' }).map((s) => s.messageId)).toEqual(['msg_2']);
    expect(transport.filter({ url: /a\.example/ }).map((s) => s.messageId)).toEqual(['msg_1', 'msg_3']);
    expect(transport.filter({ messageId: 'msg_9' })).toEqual([]);
    expect(transport.filter((s) => s.attempt === 3).map((s) => s.messageId)).toEqual(['msg_3']);

    transport.clear();
    expect(transport.sent).toEqual([]);
  });

  it("single() returns the one match, and otherwise throws listing what was sent", async () => {
    const transport = new InMemoryWebhookTransport();
    expect(() => transport.single()).toThrow('Expected one webhook matching the query, found 0. Sent: nothing');
    await transport.send(signedRequest(), options());
    await transport.send(signedRequest({ type: 'order.cancelled', url: 'https://b.example/x' }), options());
    expect(transport.single({ type: 'order.cancelled' }).url).toBe('https://b.example/x');
    expect(() => transport.single({ messageId: 'msg_1' })).toThrow(
      'Expected one webhook matching the query, found 2. Sent: order.shipped -> https://a.example/hooks; order.cancelled -> https://b.example/x',
    );
  });
});

describe('SentWebhook', () => {
  it('exposes the request, the attempt and when it was sent, and parses the data', () => {
    const request = signedRequest();
    const sentAt = new Date('2026-09-24T12:00:00Z');
    const sent = new SentWebhook(request, 2, sentAt);
    expect(sent).toMatchObject({
      url: 'https://a.example/hooks',
      type: 'order.shipped',
      messageId: 'msg_1',
      endpointId: 'ep_1',
      deliveryId: 'dlv_1',
      attempt: 2,
      sentAt,
      body: request.body,
      data: { orderId: 'o-1' },
    });
    expect(sent.headers).toBe(request.headers);
  });

  it('checks the signature against the exact body, id and timestamp', () => {
    const sent = new SentWebhook(signedRequest(), 1, new Date());
    expect(sent.isSignedWith(SECRET)).toBe(true);
    expect(sent.isSignedWith(`whsec_${Buffer.alloc(32, 9).toString('base64')}`)).toBe(false);
    const request = signedRequest();
    expect(new SentWebhook({ ...request, body: `${request.body} ` }, 1, new Date()).isSignedWith(SECRET)).toBe(false);
    expect(new SentWebhook({ ...request, headers: { ...request.headers, 'webhook-id': 'msg_2' } }, 1, new Date()).isSignedWith(SECRET)).toBe(false);
  });
});

describe('signWebhook()', () => {
  it('defaults to a random msg_ id and the current time, and keeps a string payload byte for byte', () => {
    const before = Math.floor(Date.now() / 1000);
    const a = signWebhook({ scheme: 'standard', secret: SECRET, payload: '{ "a" : 1 }' });
    const b = signWebhook({ scheme: 'standard', secret: SECRET, payload: '{ "a" : 1 }' });
    expect(a.body).toBe('{ "a" : 1 }');
    expect(a.headers['webhook-id']).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(a.headers['webhook-id']).not.toBe(b.headers['webhook-id']);
    expect(Number(a.headers['webhook-timestamp'])).toBeGreaterThanOrEqual(before);
    expect(a.headers['content-type']).toBe('application/json');
  });

  it('signs the given time in whole seconds, and names a Stripe-like header in lower case', () => {
    const at = new Date('2026-09-24T12:00:00.999Z');
    const stripe = signWebhook({ scheme: 'stripe', secret: 'sk', payload: { id: 'evt_1' }, timestamp: at, header: 'X-Partner-Signature' });
    expect(Object.keys(stripe.headers)).toEqual(['content-type', 'x-partner-signature']);
    expect(stripe.headers['x-partner-signature']).toMatch(new RegExp(`^t=${Math.floor(at.getTime() / 1000)},v1=[0-9a-f]{64}$`));
    const github = signWebhook({ scheme: 'github', secret: 'gh', payload: {} });
    expect(github.headers['x-github-delivery']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an unknown scheme, and a Standard Webhooks secret that is malformed', () => {
    expect(() => signWebhook({ scheme: 'shopify' as never, secret: 's', payload: {} })).toThrow('signWebhook(): unknown scheme "shopify"');
    expect(() => signWebhook({ scheme: 'standard', secret: 'not-a-whsec', payload: {} })).toThrow(/whsec_/);
  });
});

describe('the store contracts', () => {
  const run = async (cases: WebhookStoreContractCase[], name: string) => {
    const found = cases.find((c) => c.name.startsWith(name));
    expect(found, `no case named "${name}…"`).toBeDefined();
    return found!.run();
  };

  it('lists the concurrency cases only when asked', () => {
    const harness = () => ({ store: new InMemoryWebhookStore() });
    expect(webhookEndpointStoreContract(harness, { concurrent: true }).length).toBeGreaterThan(webhookEndpointStoreContract(harness).length);
    expect(webhookDeliveryStoreContract(harness, { concurrent: true }).length).toBeGreaterThan(webhookDeliveryStoreContract(harness).length);
    const names = [...webhookEndpointStoreContract(harness, { concurrent: true }), ...webhookDeliveryStoreContract(harness, { concurrent: true })].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('closes the harness after every case, passed or failed, and awaits an async harness', async () => {
    const closed: string[] = [];
    class Broken extends InMemoryWebhookStore {
      override deleteEndpoint(): boolean {
        return true;
      }
    }
    const harness = async () => ({ store: new Broken(), close: async () => void closed.push('closed') });
    const cases = webhookEndpointStoreContract(harness);
    await run(cases, 'stores an endpoint');
    await expect(run(cases, 'deletes an endpoint once')).rejects.toThrow();
    expect(closed).toEqual(['closed', 'closed']);
  });

  it.each<[string, () => InMemoryWebhookStore, string]>([
    [
      'claims a delivery under another lease',
      () =>
        new (class extends InMemoryWebhookStore {
          override claimDeliveries(request: WebhookClaimRequest) {
            const rows = (this as unknown as { deliveryRows: Map<string, { leaseUntil: number | null }> }).deliveryRows;
            for (const row of rows.values()) {
              row.leaseUntil = null;
            }
            return super.claimDeliveries(request);
          }
        })(),
      'claims due, unleased',
    ],
    [
      "records an attempt for a worker that doesn't hold the lease",
      () =>
        new (class extends InMemoryWebhookStore {
          override recordDeliveryAttempt(id: string, _owner: string, update: WebhookDeliveryUpdate) {
            const rows = (this as unknown as { deliveryRows: Map<string, { leaseOwner: string | null }> }).deliveryRows;
            const row = rows.get(id);
            return row ? super.recordDeliveryAttempt(id, row.leaseOwner ?? '', update) : false;
          }
        })(),
      "records an attempt only for the lease's owner",
    ],
    [
      'retries a delivery a worker is attempting',
      () =>
        new (class extends InMemoryWebhookStore {
          override retryDeliveries(filter: WebhookDeliveryFilter, now: number) {
            return super.retryDeliveries(filter, Number.MAX_SAFE_INTEGER) && super.retryDeliveries(filter, now);
          }
        })(),
      'retries matching deliveries in a new round',
    ],
    [
      'prunes a delivery that finished exactly at the cutoff',
      () =>
        new (class extends InMemoryWebhookStore {
          override pruneDeliveries(before: number) {
            return super.pruneDeliveries(before + 1);
          }
        })(),
      'prunes finished deliveries',
    ],
    [
      'creates a (message, endpoint) delivery twice',
      () =>
        new (class extends InMemoryWebhookStore {
          override createDeliveries(...args: Parameters<InMemoryWebhookStore['createDeliveries']>) {
            (this as unknown as { pairs: Map<string, string> }).pairs.clear();
            return super.createDeliveries(...args);
          }
        })(),
      'creates each (message, endpoint) delivery once',
    ],
  ])('the delivery contract catches a store that %s', async (_name, create, caseName) => {
    await expect(run(webhookDeliveryStoreContract(() => ({ store: create() })), caseName)).rejects.toThrow();
  });

  it.each<[string, () => InMemoryWebhookStore, string]>([
    [
      'changes a field the patch does not name',
      () =>
        new (class extends InMemoryWebhookStore {
          override updateEndpoint(id: string, patch: WebhookEndpointPatch, now: number) {
            return super.updateEndpoint(id, { enabled: false, ...patch }, now);
          }
        })(),
      'updates only the fields in the patch',
    ],
    [
      'keeps a disabled endpoint enabled after 410 Gone',
      () =>
        new (class extends InMemoryWebhookStore {
          override recordEndpointFailure(...args: Parameters<InMemoryWebhookStore['recordEndpointFailure']>) {
            super.recordEndpointFailure(...args);
            return false;
          }
        })(),
      'disables at once for 410 Gone',
    ],
    [
      'lists every endpoint when no limit is given',
      () =>
        new (class extends InMemoryWebhookStore {
          override listEndpoints(query: Parameters<InMemoryWebhookStore['listEndpoints']>[0]) {
            return super.listEndpoints({ limit: 1_000, ...query });
          }
        })(),
      'lists 50 endpoints unless asked for more',
    ],
  ])('the endpoint contract catches a store that %s', async (_name, create, caseName) => {
    await expect(run(webhookEndpointStoreContract(() => ({ store: create() })), caseName)).rejects.toThrow();
  });
});
