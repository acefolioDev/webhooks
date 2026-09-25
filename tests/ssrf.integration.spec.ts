/**
 * The SSRF guard end to end: the store's partner API and worker with the real `HttpWebhookTransport`,
 * and a partner listening on 127.0.0.1. By default the loopback receiver is out of reach, at
 * `create()` for a literal address and at every send for a name that resolves to it; the
 * documented allowances (`allowPrivateNetworks`, `allowedAddresses`) reach it, and cloud
 * metadata addresses stay blocked whatever they allow. Names resolve through a stub resolver
 * (the transport's `lookup` option): no DNS leaves the machine.
 */
import request from 'supertest';
import { adapters } from './support/adapters.js';
import { HttpWebhookTransport, InMemoryWebhookStore, WebhookDestinationBlockedError, type ResolvedAddress } from '../lib/index.js';
import { useStore } from './helpers.js';
import { listenToChannels, startReceiver, startSender, STANDARD_SECRET, type Receiver, type Sender } from './integration.js';

/** Answers from a table, and records every question. */
function resolver(answers: Record<string, string | ((call: number) => string)>) {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (hostname: string): Promise<ResolvedAddress[]> => {
      asked.push(hostname);
      const answer = answers[hostname];
      const address = typeof answer === 'function' ? answer(asked.filter((name) => name === hostname).length) : answer;
      if (address === undefined) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      }
      return [{ address, family: address.includes(':') ? 6 : 4 }];
    },
  };
}

describe.each(adapters.map((a) => a.name))('the SSRF guard between two apps on %s', (adapter) => {
  let receiver: Receiver;
  let senders: Sender[] = [];
  let channels: ReturnType<typeof listenToChannels>;

  beforeEach(async () => {
    receiver = await startReceiver(adapter);
    channels = listenToChannels();
  });
  afterEach(async () => {
    channels.close();
    for (const sender of senders) {
      await sender.close();
    }
    senders = [];
    await receiver.close();
  });

  /** The store with the given delivery options, the module building the transport from them. */
  async function store(delivery: Record<string, unknown>, extra: Parameters<typeof startSender>[1] = {}) {
    const sender = await startSender(adapter, { options: { delivery: { timeout: '1s', ...delivery } }, ...extra });
    senders.push(sender);
    return sender;
  }

  /** The store with a transport built in the async factory, the way to give it a resolver. */
  async function storeWithResolver(transport: ConstructorParameters<typeof HttpWebhookTransport>[0], delivery: Record<string, unknown> = { allowHttp: true }) {
    const sender = await startSender(adapter, {
      asyncOptions: {
        useFactory: () => ({ worker: { enabled: false }, retry: 3, delivery, transport: new HttpWebhookTransport(transport) }),
      },
    });
    senders.push(sender);
    return sender;
  }

  const subscribe = (sender: Sender, url: string) =>
    request(sender.server()).post('/partners/shop-1/webhook-endpoints').send({ url, eventTypes: ['*'], secret: STANDARD_SECRET });
  const ship = (sender: Sender, orderId = 'o-1') => request(sender.server()).post(`/orders/${orderId}/ship`).send({ tenant: 'shop-1' }).expect(201);

  it('refuses the loopback receiver at create() by default, as an address, as localhost, and in its other spellings', async () => {
    const sender = await store({ allowHttp: true });

    for (const url of [receiver.url(), receiver.url('standard', 'localhost'), receiver.url('standard', '2130706433'), receiver.url('standard', '[::ffff:127.0.0.1]')]) {
      const { status, body } = await subscribe(sender, url);
      expect({ url, status, field: body.field }).toEqual({ url, status: 400, field: 'url' });
      expect(body.message).toMatch(/loopback/);
    }
    expect(await sender.endpoints.list()).toEqual([]);

    // A name passes without DNS at create(); moving the endpoint onto loopback afterwards doesn't.
    const { body: endpoint } = await subscribe(sender, `http://hooks.partner.test:${receiver.port}/hooks/standard`).expect(201);
    const { body } = await request(sender.server()).patch(`/partners/shop-1/webhook-endpoints/${endpoint.id}`).send({ url: receiver.url() }).expect(400);
    expect(body).toMatchObject({ field: 'url', message: expect.stringMatching(/loopback/) });
    expect((await sender.endpoints.get(endpoint.id))!.url).toBe(`http://hooks.partner.test:${receiver.port}/hooks/standard`);
  });

  it('refuses http: unless allowHttp, at create() and at send for an endpoint stored while it was allowed', async () => {
    const webhookStore = new InMemoryWebhookStore();
    const before = await store({ allowHttp: true, allowPrivateNetworks: true }, { override: useStore(webhookStore) });
    await subscribe(before, receiver.url()).expect(201);

    const after = await store({ allowPrivateNetworks: true }, { override: useStore(webhookStore) });
    const { body } = await subscribe(after, receiver.url()).expect(400);
    expect(body).toMatchObject({ field: 'url', message: expect.stringMatching(/only https/) });

    await ship(after);
    expect(await after.flush()).toMatchObject({ failed: 1 });
    expect(receiver.partner.hits).toEqual([]);
    expect(after.events.map((event) => event.type)).toEqual(['destination-blocked', 'delivery-failed']);
  });

  it('checks the address a name resolves to at every send: a partner name pointing at loopback is blocked, never retried, and reported', async () => {
    const dns = resolver({ 'hooks.partner.test': '127.0.0.1' });
    const sender = await storeWithResolver({ allowHttp: true, lookup: dns.lookup });
    const url = `http://hooks.partner.test:${receiver.port}/hooks/standard?token=s3cr3t`;
    const { body: endpoint } = await subscribe(sender, url).expect(201);
    await ship(sender);

    expect(await sender.flush()).toMatchObject({ failed: 1 });
    expect(receiver.partner.hits).toEqual([]);
    expect(dns.asked).toEqual(['hooks.partner.test']);
    expect(sender.events).toEqual([
      {
        type: 'destination-blocked',
        endpointId: endpoint.id,
        tenant: 'shop-1',
        reason: 'hooks.partner.test resolves to 127.0.0.1, loopback',
        address: '127.0.0.1',
      },
      expect.objectContaining({ type: 'delivery-failed', reason: 'rejected', error: expect.any(WebhookDestinationBlockedError) }),
    ]);
    expect(channels.types()).toEqual(['destination-blocked', 'delivery-failed']);
    expect(sender.logger.lines).toContainEqual(expect.stringContaining('Refused to deliver'));

    // The error in the log names the origin, never the path or the query where tokens live.
    const [delivery] = await sender.deliveries.list();
    expect(delivery).toMatchObject({ status: 'failed', failureReason: 'rejected', lastStatusCode: null });
    expect(delivery!.lastError).toContain(`http://hooks.partner.test:${receiver.port}`);
    expect(delivery!.lastError).not.toMatch(/token|s3cr3t|\/hooks\/standard/);

    // A refusal counts against the endpoint's health.
    expect((await sender.endpoints.get(endpoint.id))!.failingSince).toEqual(expect.any(Number));
  });

  it('reaches the partner with allowPrivateNetworks, by address, by localhost, and by a name', async () => {
    const dns = resolver({ 'hooks.partner.test': '127.0.0.1' });
    const sender = await storeWithResolver({ allowHttp: true, allowPrivateNetworks: true, lookup: dns.lookup }, { allowHttp: true, allowPrivateNetworks: true });
    for (const host of ['127.0.0.1', 'localhost', 'hooks.partner.test']) {
      await subscribe(sender, receiver.url('counted', host)).expect(201);
    }
    await ship(sender);

    expect(await sender.flush()).toMatchObject({ delivered: 3 });
    expect(receiver.partner.of('counted').map((hit) => String(hit.headers.host).split(':')[0]).sort()).toEqual(['127.0.0.1', 'hooks.partner.test', 'localhost']);
    expect(dns.asked).toEqual(['hooks.partner.test']);
  });

  it('keeps metadata addresses blocked even with allowPrivateNetworks, at create() and behind a name', async () => {
    const dns = resolver({ 'metadata.partner.test': '169.254.169.254', 'azure.partner.test': '168.63.129.16' });
    const sender = await storeWithResolver({ allowHttp: true, allowPrivateNetworks: true, lookup: dns.lookup }, { allowHttp: true, allowPrivateNetworks: true });

    const { body } = await subscribe(sender, 'http://169.254.169.254/latest/meta-data/').expect(400);
    expect(body.message).toMatch(/link-local/);
    await subscribe(sender, `http://metadata.partner.test:${receiver.port}/hooks/standard`).expect(201);
    await subscribe(sender, `http://azure.partner.test:${receiver.port}/hooks/standard`).expect(201);
    await ship(sender);

    expect(await sender.flush()).toMatchObject({ failed: 2 });
    expect(sender.events.filter((event) => event.type === 'destination-blocked').map((event) => (event as { address: string }).address).sort()).toEqual([
      '168.63.129.16',
      '169.254.169.254',
    ]);
  });

  it('reaches only the ranges allowedAddresses lists, and checks the name again when its DNS changes', async () => {
    // Allowed at the first send; the name then moves into a private range the list doesn't cover.
    const dns = resolver({ 'hooks.partner.test': (call) => (call === 1 ? '127.0.0.1' : '10.0.0.7') });
    const sender = await storeWithResolver({ allowHttp: true, allowedAddresses: ['127.0.0.1/32'], lookup: dns.lookup });
    await subscribe(sender, `http://hooks.partner.test:${receiver.port}/hooks/standard`).expect(201);

    await ship(sender, 'o-1');
    expect(await sender.flush()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.hits).toEqual([expect.objectContaining({ headers: expect.objectContaining({ host: `hooks.partner.test:${receiver.port}` }) })]);

    await ship(sender, 'o-2');
    expect(await sender.flush()).toMatchObject({ failed: 1 });
    expect(sender.events.at(-2)).toMatchObject({ type: 'destination-blocked', address: '10.0.0.7', reason: expect.stringMatching(/private/) });
    expect(receiver.partner.hits).toHaveLength(1);
    expect(dns.asked).toEqual(['hooks.partner.test', 'hooks.partner.test']);
  });

  it('retries a name that does not resolve, as an outage rather than a refusal', async () => {
    const dns = resolver({});
    const sender = await storeWithResolver({ allowHttp: true, lookup: dns.lookup });
    await subscribe(sender, `http://gone.partner.test:${receiver.port}/hooks/standard`).expect(201);
    await ship(sender);

    expect(await sender.flush()).toMatchObject({ retried: 1 });
    expect(sender.events).toEqual([expect.objectContaining({ type: 'retry-scheduled', statusCode: null })]);
    expect((await sender.deliveries.list())[0]!.lastError).toMatch(/ENOTFOUND/);
  });
});
