/**
 * The store's API sends to a partner's service, both real applications on the same adapter, over
 * real HTTP through the default transport: the partner API recipe creates the endpoint, an
 * order ships inside a transaction, the relay fans out and the worker delivers to
 * `@VerifyWebhook()` routes. Then how the sender behaves when the partner fails, asks for a
 * breather, is gone, hangs or redirects, as the events, the diagnostics channels and the
 * delivery log report it.
 */
import { OutboxStorage } from '@nestjs/outbox';
import request from 'supertest';
import { adapters } from './support/adapters.js';
import { WebhookDeliveryTimeoutError, WebhookResponseError } from '../lib/index.js';
import { controllableClock, until } from './helpers.js';
import { inTurn, listenToChannels, startReceiver, startSender, STANDARD_SECRET, type Receiver, type Sender } from './integration.js';

describe.each(adapters.map((a) => a.name))('the store delivering to a partner, both on %s', (adapter) => {
  let receiver: Receiver;
  let sender: Sender | undefined;
  let channels: ReturnType<typeof listenToChannels>;

  beforeEach(async () => {
    receiver = await startReceiver(adapter);
    channels = listenToChannels();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    channels.close();
    await sender?.close();
    sender = undefined;
    await receiver.close();
  });

  async function subscribe(options: Parameters<typeof startSender>[1] = {}, tenant = 'shop-1', path = 'standard') {
    sender = await startSender(adapter, options);
    const { body } = await request(sender.server())
      .post(`/partners/${tenant}/webhook-endpoints`)
      .send({ url: receiver.url(path), eventTypes: ['order.shipped'], secret: STANDARD_SECRET })
      .expect(201);
    return { sender, endpoint: body as { id: string; secret: string } };
  }

  const ship = (orderId: string, body: Record<string, unknown> = { tenant: 'shop-1' }) => request(sender!.server()).post(`/orders/${orderId}/ship`).send(body);

  it('sends a shipped order to the partner, signed, once, and logs the response; a rolled-back order sends nothing', async () => {
    const { endpoint } = await subscribe();
    expect(endpoint.secret).toBe(STANDARD_SECRET);
    await request(sender!.server())
      .post('/partners/shop-2/webhook-endpoints')
      .send({ url: receiver.url('counted'), eventTypes: ['*'], secret: STANDARD_SECRET })
      .expect(201);

    const { body: message } = await ship('o-1').expect(201);
    await ship('o-2', { tenant: 'shop-1', fail: true }).expect(409);
    expect(await sender!.transactions.shipped()).toEqual(['o-1']);

    expect(await sender!.flush()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(receiver.partner.hits).toHaveLength(1);
    const [hit] = receiver.partner.hits;
    expect(hit).toMatchObject({
      route: 'standard',
      id: message.id,
      payload: { type: 'order.shipped', timestamp: new Date(message.createdAt).toISOString(), data: { orderId: 'o-1', carrier: 'standard-post' } },
      headers: { 'user-agent': 'NestJS-Webhooks/1.0', 'content-type': 'application/json', 'webhook-id': message.id },
    });
    expect(sender!.events).toEqual([expect.objectContaining({ type: 'delivered', statusCode: 200, attempt: 1 })]);
    expect(channels.types()).toEqual(['delivered']);

    const { body: log } = await request(sender!.server()).get('/partners/shop-1/webhook-deliveries').expect(200);
    expect(log).toEqual([expect.objectContaining({ messageId: message.id, endpointId: endpoint.id, status: 'succeeded', lastStatusCode: 200, attempts: 1 })]);
    await request(sender!.server()).get(`/partners/shop-2/webhook-deliveries/${log[0].id}`).expect(404);

    // A replay reaches the partner with the same webhook-id: its inbox answers 2xx without running the handler.
    await request(sender!.server()).post(`/partners/shop-1/webhook-deliveries/${log[0].id}/retry`).expect(200, { retried: 1 });
    expect(await sender!.worker.runOnce()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.hits).toHaveLength(1);

    const { body: details } = await request(sender!.server()).get(`/partners/shop-1/webhook-deliveries/${log[0].id}`).expect(200);
    expect(details.message).toMatchObject({ id: message.id, body: message.body });
    expect(details.history.map((attempt: { statusCode: number }) => attempt.statusCode)).toEqual([200, 200]);
  });

  it('retries a partner that fails, and the handler that threw runs again on the retry', async () => {
    const clock = controllableClock();
    await subscribe();
    receiver.partner.answer = inTurn({ fail: true }, { status: 500 }, {});
    const { body: message } = await ship('o-1').expect(201);

    expect(await sender!.flush()).toMatchObject({ retried: 1 });
    clock.advance(1_000);
    expect(await sender!.worker.runOnce()).toMatchObject({ retried: 1 });
    clock.advance(2_000);
    expect(await sender!.worker.runOnce()).toMatchObject({ delivered: 1 });

    expect(receiver.partner.hits.map((hit) => hit.id)).toEqual([message.id, message.id, message.id]);
    expect(sender!.events.map((event) => event.type)).toEqual(['retry-scheduled', 'retry-scheduled', 'delivered']);
    expect(sender!.events.slice(0, 2)).toEqual([
      expect.objectContaining({ statusCode: 500, attempt: 1, delayMs: 1_000, error: expect.any(WebhookResponseError) }),
      expect.objectContaining({ statusCode: 500, attempt: 2, delayMs: 2_000 }),
    ]);
    expect(channels.types()).toEqual(['retry-scheduled', 'retry-scheduled', 'delivered']);
    expect(sender!.logger.lines.filter((line) => line.startsWith('[WebhookWorker] WARN Retrying'))).toHaveLength(2);

    const [delivery] = await sender!.deliveries.list({ messageId: message.id });
    const details = await sender!.deliveries.get(delivery!.id);
    expect(details!.history.map((attempt) => [attempt.attempt, attempt.statusCode])).toEqual([
      [1, 500],
      [2, 500],
      [3, 200],
    ]);
    expect(details!.history[0]!.response).toContain('Internal server error');
  });

  it("waits the partner's Retry-After after a 429, holding back the endpoint's other deliveries without an attempt", async () => {
    const clock = controllableClock();
    await subscribe();
    receiver.partner.answer = inTurn({ status: 429, headers: { 'retry-after': '30' } }, {});
    for (const id of ['o-1', 'o-2', 'o-3']) {
      await ship(id).expect(201);
    }

    expect(await sender!.flush()).toMatchObject({ claimed: 3, retried: 1, released: 2 });
    expect(receiver.partner.hits).toHaveLength(1);
    expect(sender!.events).toEqual([expect.objectContaining({ type: 'retry-scheduled', statusCode: 429, delayMs: 30_000 })]);
    const stats = await sender!.deliveries.stats();
    expect(stats).toMatchObject({ pending: 3, due: 0, failed: 0 });

    clock.advance(29_000);
    expect(await sender!.worker.runOnce()).toMatchObject({ claimed: 0 });
    clock.advance(1_000);
    expect(await sender!.worker.runOnce()).toMatchObject({ claimed: 3, delivered: 3 });
    expect(new Set(receiver.partner.hits.map((hit) => hit.payload.data.orderId))).toEqual(new Set(['o-1', 'o-2', 'o-3']));
  });

  it('disables an endpoint that answers 410 Gone, sends it nothing new, and catches up once re-enabled', async () => {
    const { endpoint } = await subscribe();
    receiver.partner.answer = inTurn({ status: 410 }, {});
    await ship('o-1').expect(201);

    expect(await sender!.flush()).toMatchObject({ failed: 1 });
    expect(sender!.events).toEqual([
      { type: 'endpoint-disabled', endpointId: endpoint.id, tenant: 'shop-1', reason: 'gone' },
      expect.objectContaining({ type: 'delivery-failed', reason: 'rejected', statusCode: 410 }),
    ]);
    expect(channels.types()).toEqual(['endpoint-disabled', 'delivery-failed']);
    const { body: endpoints } = await request(sender!.server()).get('/partners/shop-1/webhook-endpoints').expect(200);
    expect(endpoints).toEqual([expect.objectContaining({ id: endpoint.id, enabled: false, disabledReason: 'gone' })]);

    await ship('o-2').expect(201);
    expect(await sender!.flush()).toMatchObject({ claimed: 0 });
    expect(await sender!.deliveries.list({ tenant: 'shop-1' })).toHaveLength(1);

    // The partner is back: re-enabled, and what failed is sent again with the same webhook-id.
    await request(sender!.server()).patch(`/partners/shop-1/webhook-endpoints/${endpoint.id}`).send({ enabled: true }).expect(200);
    await request(sender!.server()).post('/partners/shop-1/webhook-deliveries/retry').send({ endpointId: endpoint.id }).expect(200, { retried: 1 });
    expect(await sender!.worker.runOnce()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.hits.map((hit) => hit.payload.data.orderId)).toEqual(['o-1', 'o-1']);
  });

  it('disables an endpoint that failed every attempt for disableEndpointAfter, once', async () => {
    const clock = controllableClock();
    const { endpoint } = await subscribe({ options: { disableEndpointAfter: '1h', retry: { attempts: 10, backoff: { delay: '10m', factor: 1, jitter: 'none' } } } });
    receiver.partner.answer = () => ({ status: 500 });
    await ship('o-1').expect(201);

    expect(await sender!.flush()).toMatchObject({ retried: 1 });
    for (let i = 0; i < 6; i++) {
      clock.advance(10 * 60_000);
      await sender!.worker.runOnce();
    }

    expect(sender!.events.filter((event) => event.type === 'endpoint-disabled')).toEqual([
      { type: 'endpoint-disabled', endpointId: endpoint.id, tenant: 'shop-1', reason: 'failing' },
    ]);
    expect(await sender!.endpoints.get(endpoint.id)).toMatchObject({ enabled: false, disabledReason: 'failing' });
    expect(sender!.logger.lines).toContainEqual(expect.stringContaining(`Disabled webhook endpoint ${endpoint.id}`));

    // Its pending delivery fails without an attempt when its turn comes.
    clock.advance(10 * 60_000);
    expect(await sender!.worker.runOnce()).toMatchObject({ failed: 1 });
    expect(receiver.partner.hits).toHaveLength(7);
    expect(sender!.events.at(-1)).toMatchObject({ type: 'delivery-failed', reason: 'endpoint-disabled' });
  });

  it('gives up on a partner that hangs at delivery.timeout; the retry finds the id in its inbox', async () => {
    const clock = controllableClock();
    await subscribe({ options: { delivery: { allowHttp: true, allowPrivateNetworks: true, timeout: '300ms' } } });
    receiver.partner.answer = inTurn({ hang: true }, {});
    const { body: message } = await ship('o-1').expect(201);

    const started = performance.now();
    expect(await sender!.flush()).toMatchObject({ retried: 1 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(sender!.events).toEqual([expect.objectContaining({ type: 'retry-scheduled', statusCode: null, error: expect.any(WebhookDeliveryTimeoutError) })]);
    expect((await sender!.deliveries.list())[0]).toMatchObject({ lastStatusCode: null, lastError: 'WebhookDeliveryTimeoutError: No response within 300ms' });

    // The handler finishes after the sender gave up, and the inbox records the id.
    receiver.partner.release();
    const inbox = receiver.app.get(OutboxStorage).inbox;
    await until(() => inbox.hasInbox('webhooks:standard', message.id));

    clock.advance(1_000);
    expect(await sender!.worker.runOnce()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.hits).toHaveLength(1);
  });

  it('never follows a redirect: a 3xx is a failed attempt, and the target is never called', async () => {
    await subscribe();
    receiver.partner.answer = () => ({ status: 307, headers: { location: receiver.url('counted') } });
    await ship('o-1').expect(201);

    expect(await sender!.flush()).toMatchObject({ retried: 1 });
    expect(receiver.partner.of('counted')).toEqual([]);
    expect((await sender!.deliveries.list())[0]).toMatchObject({ lastStatusCode: 307, lastError: expect.stringContaining('307') });
  });

  it('keeps only the first delivery.maxResponseSize bytes of what the partner answered', async () => {
    await subscribe({ options: { delivery: { allowHttp: true, allowPrivateNetworks: true, maxResponseSize: 64 } } });
    receiver.partner.answer = () => ({ body: 'x'.repeat(100_000) });
    await ship('o-1').expect(201);

    expect(await sender!.flush()).toMatchObject({ delivered: 1 });
    const [delivery] = await sender!.deliveries.list();
    const details = await sender!.deliveries.get(delivery!.id);
    expect(details!.history[0]!.response).toBe('x'.repeat(64));
  });

  it('delivers on its own with the relay and the worker running, and stops cleanly', async () => {
    await subscribe({
      relay: { enabled: true, pollInterval: '1m' },
      options: { worker: { enabled: true, pollInterval: '1m' } },
    });
    // notify() after the commit wakes the relay, and the fan-out wakes the worker: no poll interval passes.
    const { body: message } = await ship('o-1').expect(201);

    await until(() => receiver.partner.hits.length === 1);
    expect(receiver.partner.hits[0]!.id).toBe(message.id);
    await until(async () => (await sender!.deliveries.list())[0]?.status === 'succeeded');
    await sender!.close();
    expect(sender!.worker.running).toBe(false);
    sender = undefined;
  });
});
