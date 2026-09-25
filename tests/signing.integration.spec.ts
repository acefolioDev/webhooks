/**
 * Signatures end to end: the store's worker sends to a partner that verifies with each scheme the
 * README lists (Standard Webhooks as sent, and Stripe-style, GitHub and a custom Shopify
 * scheme through a transport that re-signs, the README's recipe), secrets rotating while a
 * delivery is being retried, and what someone who captured a request can do with it: a copy
 * inside the tolerance is skipped by the inbox, an old or tampered one is refused.
 */
import request from 'supertest';
import { adapters } from './support/adapters.js';
import { WebhookTransport, type WebhooksVerificationFailedEvent } from '../lib/index.js';
import { controllableClock } from './helpers.js';
import {
  inTurn,
  listenToChannels,
  NEXT_SECRET,
  partnerReceivers,
  resend,
  ResigningTransport,
  startReceiver,
  startSender,
  STANDARD_SECRET,
  type Receiver,
  type Sender,
} from './integration.js';

const SCHEMES = ['standard', 'stripe', 'github', 'shopify'] as const;

describe.each(adapters.map((a) => a.name))('signatures between two apps on %s', (adapter) => {
  let receiver: Receiver;
  let sender: Sender;
  let channels: ReturnType<typeof listenToChannels>;

  beforeEach(() => {
    channels = listenToChannels();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    channels.close();
    await sender?.close();
    await receiver?.close();
  });

  async function start(receiverSecrets: string[] = [STANDARD_SECRET], tolerance?: string) {
    receiver = await startReceiver(adapter, { receivers: partnerReceivers(receiverSecrets, tolerance) });
    sender = await startSender(adapter, { options: { transport: ResigningTransport } });
    const endpoints: Record<string, string> = {};
    for (const scheme of SCHEMES) {
      const created = await sender.endpoints.create({ url: receiver.url(scheme), eventTypes: ['order.shipped'], tenant: 'shop-1', secret: STANDARD_SECRET });
      endpoints[scheme] = created.id;
    }
    return { endpoints, transport: sender.app.get(WebhookTransport) as ResigningTransport };
  }

  const ship = (orderId: string) => request(sender.server()).post(`/orders/${orderId}/ship`).send({ tenant: 'shop-1' }).expect(201);
  const failures = () => receiver.events.filter((event): event is WebhooksVerificationFailedEvent => event.type === 'verification-failed');

  it('delivers to a Standard Webhooks, a Stripe-style, a GitHub and a custom receiver, each deduplicating a replay by its own id', async () => {
    await start();
    const { body: message } = await ship('o-1');

    expect(await sender.flush()).toMatchObject({ claimed: 4, delivered: 4 });
    const hits = Object.fromEntries(receiver.partner.hits.map((hit) => [hit.route, hit]));
    for (const scheme of SCHEMES) {
      expect(hits[scheme]).toMatchObject({ id: message.id, payload: { type: 'order.shipped', data: { orderId: 'o-1', carrier: 'standard-post' } } });
    }
    // Standard Webhooks and Stripe sign the time; GitHub and this Shopify scheme don't.
    expect(hits.standard!.timestamp).toBeInstanceOf(Date);
    expect(hits.stripe!.timestamp).toEqual(hits.standard!.timestamp);
    expect(hits.github!.timestamp).toBeNull();
    expect(hits.shopify!.timestamp).toBeNull();
    expect(hits.stripe!.payload.id).toBe(message.id);
    expect(hits.stripe!.headers).toMatchObject({ 'store-signature': expect.stringMatching(/^t=\d+,v1=[0-9a-f]{64}$/) });
    expect(hits.github!.headers).toMatchObject({ 'x-hub-signature-256': expect.stringMatching(/^sha256=/), 'x-github-delivery': message.id });

    expect(await sender.deliveries.retry({ all: true })).toBe(4);
    expect(await sender.worker.runOnce()).toMatchObject({ delivered: 4 });
    expect(receiver.partner.hits).toHaveLength(4);
    expect(failures()).toEqual([]);
  });

  it('refuses every scheme signed with a secret the partner does not have: 401 without the reason, which goes to its events', async () => {
    await start([NEXT_SECRET]);
    await ship('o-1');

    expect(await sender.flush()).toMatchObject({ retried: 4 });
    expect(receiver.partner.hits).toEqual([]);
    const log = await sender.deliveries.list();
    expect(log.map((delivery) => delivery.lastStatusCode)).toEqual([401, 401, 401, 401]);
    for (const delivery of log) {
      const details = await sender.deliveries.get(delivery.id);
      expect(details!.history[0]!.response).toContain('Webhook signature verification failed');
      expect(details!.history[0]!.response).not.toContain('invalid-signature');
    }

    expect(failures().map((event) => [event.receiver, event.reason]).sort()).toEqual(SCHEMES.map((scheme) => [scheme, 'invalid-signature']).sort());
    expect(channels.published.filter((entry) => entry.channel === 'nestjs:webhooks:verification-failed')).toHaveLength(4);
  });

  it('keeps a retried delivery verifying through a rotation, then retires the old secret; overlap 0 cuts it off at once', async () => {
    const clock = controllableClock();
    receiver = await startReceiver(adapter);
    sender = await startSender(adapter);
    const endpoint = await sender.endpoints.create({ url: receiver.url('standard'), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
    receiver.partner.answer = inTurn({ status: 503 }, {});
    await ship('o-1');
    expect(await sender.flush()).toMatchObject({ retried: 1 });

    // The store rotates while the delivery waits for its retry; the partner still has the old secret only.
    const { body: rotated } = await request(sender.server())
      .post(`/partners/shop-1/webhook-endpoints/${endpoint.id}/rotate-secret`)
      .send({ overlap: '1h' })
      .expect(200);
    clock.advance(5_000);
    expect(await sender.worker.runOnce()).toMatchObject({ delivered: 1 });
    expect(String(receiver.partner.hits[1]!.headers['webhook-signature']).split(' ')).toHaveLength(2);

    // The partner deploys the new secret alone (on another port here).
    await receiver.close();
    receiver = await startReceiver(adapter, { receivers: partnerReceivers([rotated.secret]) });
    await request(sender.server()).patch(`/partners/shop-1/webhook-endpoints/${endpoint.id}`).send({ url: receiver.url('standard') }).expect(200);
    await ship('o-2');
    expect(await sender.flush()).toMatchObject({ delivered: 1 });

    clock.advance(60 * 60_000);
    await ship('o-3');
    expect(await sender.flush()).toMatchObject({ delivered: 1 });
    expect(String(receiver.partner.hits.at(-1)!.headers['webhook-signature']).split(' ')).toHaveLength(1);

    // A leaked secret: overlap 0 retires it at once, and the partner, still on it, refuses.
    await request(sender.server()).post(`/partners/shop-1/webhook-endpoints/${endpoint.id}/rotate-secret`).send({ overlap: 0 }).expect(200);
    await ship('o-4');
    expect(await sender.flush()).toMatchObject({ retried: 1 });
    expect(sender.events.at(-1)).toMatchObject({ type: 'retry-scheduled', statusCode: 401 });
    expect(failures()).toEqual([{ type: 'verification-failed', receiver: 'standard', reason: 'invalid-signature' }]);
  });

  it('skips a captured copy inside the tolerance, and refuses it tampered, stripped or too old', async () => {
    const clock = controllableClock();
    const { transport } = await start([STANDARD_SECRET], '5m');
    await ship('o-1');
    expect(await sender.flush()).toMatchObject({ delivered: 4 });
    const captured = Object.fromEntries(transport.sent.map((sent) => [new URL(sent.url).pathname.split('/').pop(), sent]));

    // A copy of the Standard Webhooks request: a 2xx from the inbox, the handler not run.
    expect((await resend(captured.standard!)).status).toBe(200);
    expect(receiver.partner.of('standard')).toHaveLength(1);

    expect((await resend(captured.standard!, { body: captured.standard!.body.replace('o-1', 'o-9') })).status).toBe(401);
    const { 'webhook-signature': _signature, ...unsigned } = captured.standard!.headers;
    expect((await resend({ ...captured.standard!, headers: unsigned })).status).toBe(401);
    clock.advance(5 * 60_000 + 1_000);
    expect((await resend(captured.standard!)).status).toBe(401);
    expect((await resend(captured.stripe!)).status).toBe(401);

    expect(failures().map((event) => [event.receiver, event.reason])).toEqual([
      ['standard', 'invalid-signature'],
      ['standard', 'missing-header'],
      ['standard', 'timestamp-out-of-tolerance'],
      ['stripe', 'timestamp-out-of-tolerance'],
    ]);
  });

  it("verifies a GitHub copy forever, and runs it again under a new delivery id (the scheme signs neither)", async () => {
    const clock = controllableClock();
    const { transport } = await start();
    await ship('o-1');
    await sender.flush();
    const captured = transport.sent.find((sent) => sent.url.endsWith('/github'))!;

    clock.advance(24 * 60 * 60_000);
    expect((await resend(captured)).status).toBe(200);
    expect(receiver.partner.of('github')).toHaveLength(1);
    expect((await resend(captured, { headers: { 'x-github-delivery': 'forged-1' } })).status).toBe(200);
    expect(receiver.partner.of('github').map((hit) => hit.id)).toEqual([captured.messageId, 'forged-1']);
  });
});
