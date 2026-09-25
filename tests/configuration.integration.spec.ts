/**
 * The module configured as the docs page's tutorial does, from injected configuration, and
 * what those options change on the wire between two real apps: `forRootAsync()` with
 * `useFactory` and with `useClass`, `eventTypes` guarding both the partner API and
 * `dispatch()` (inside the transaction), and the `userAgent` the partner sees. Then the
 * worker's lifecycle against a real partner: shutdown during an attempt, and a lease left by a
 * worker that died.
 */
import { Injectable, Module } from '@nestjs/common';
import request from 'supertest';
import { adapters } from './support/adapters.js';
import { WEBHOOKS_MODULE_OPTIONS, WebhooksStorage, type WebhooksModuleOptions, type WebhooksOptionsFactory } from '../lib/index.js';
import { controllableClock, until } from './helpers.js';
import { startReceiver, startSender, STANDARD_SECRET, type Receiver, type Sender } from './integration.js';

/** What `ConfigService` would hold: read from the environment in a real app. */
@Injectable()
class StoreConfig {
  readonly values: Record<string, string> = {
    NODE_ENV: 'development',
    WEBHOOKS_WORKER: 'off',
    WEBHOOKS_USER_AGENT: 'CatStore-Webhooks/2.0',
  };

  get(key: string): string {
    return this.values[key]!;
  }
}

@Module({ providers: [StoreConfig], exports: [StoreConfig] })
class StoreConfigModule {}

@Injectable()
class WebhooksConfigService implements WebhooksOptionsFactory {
  constructor(private readonly config: StoreConfig) {}

  createWebhooksOptions(): WebhooksModuleOptions {
    return {
      eventTypes: ['order.shipped', 'order.cancelled'],
      delivery: { allowHttp: this.config.get('NODE_ENV') !== 'production', allowPrivateNetworks: true, userAgent: this.config.get('WEBHOOKS_USER_AGENT') },
      worker: { enabled: this.config.get('WEBHOOKS_WORKER') !== 'off' },
    };
  }
}

describe.each(adapters.map((a) => a.name))('configuring the store on %s', (adapter) => {
  let receiver: Receiver;
  let sender: Sender | undefined;

  beforeEach(async () => {
    receiver = await startReceiver(adapter);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await sender?.close();
    sender = undefined;
    await receiver.close();
  });

  const variants = {
    useFactory: {
      imports: [StoreConfigModule],
      inject: [StoreConfig],
      useFactory: (config: StoreConfig) => new WebhooksConfigService(config).createWebhooksOptions(),
    },
    useClass: { imports: [StoreConfigModule], useClass: WebhooksConfigService },
  };

  it.each(Object.keys(variants) as (keyof typeof variants)[])('builds the sender from injected configuration with %s', async (variant) => {
    sender = await startSender(adapter, { asyncOptions: variants[variant] });
    expect(sender.app.get(WEBHOOKS_MODULE_OPTIONS)).toMatchObject({ eventTypes: ['order.shipped', 'order.cancelled'] });
    expect(sender.worker.running).toBe(false);

    const { body: refused } = await request(sender.server())
      .post('/partners/shop-1/webhook-endpoints')
      .send({ url: receiver.url(), eventTypes: ['order.refunded'], secret: STANDARD_SECRET })
      .expect(400);
    expect(refused.field).toBe('eventTypes');
    await request(sender.server()).post('/partners/shop-1/webhook-endpoints').send({ url: receiver.url(), eventTypes: ['*'], secret: STANDARD_SECRET }).expect(201);

    // An unknown type fails inside the transaction: the shipment rolls back with it.
    await request(sender.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1', type: 'order.refunded' }).expect(500);
    await request(sender.server()).post('/orders/o-2/ship').send({ tenant: 'shop-1', type: 'order.cancelled' }).expect(201);
    expect(await sender.transactions.shipped()).toEqual(['o-2']);

    expect(await sender.flush()).toMatchObject({ delivered: 1 });
    expect(receiver.partner.hits).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ type: 'order.cancelled' }), headers: expect.objectContaining({ 'user-agent': 'CatStore-Webhooks/2.0' }) }),
    ]);
  });

  it('finishes the attempt in flight when the app shuts down, and records it', async () => {
    sender = await startSender(adapter, { relay: { enabled: true, pollInterval: '1m' }, options: { worker: { enabled: true, pollInterval: '1m' } } });
    await sender.endpoints.create({ url: receiver.url(), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
    receiver.partner.answer = () => ({ hang: true });
    await request(sender.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
    await until(() => receiver.partner.hits.length === 1);

    const closing = sender.close();
    setTimeout(() => receiver.partner.release(), 50);
    await closing;

    expect(sender.events.map((event) => event.type)).toEqual(['delivered']);
    expect(await sender.deliveries.list()).toEqual([expect.objectContaining({ status: 'succeeded', lastStatusCode: 200 })]);
    sender = undefined;
  });

  it('sends a delivery claimed by a worker that died once its lease expires, not before', async () => {
    const clock = controllableClock();
    sender = await startSender(adapter, { options: { worker: { enabled: false, lease: '30s' } } });
    await sender.endpoints.create({ url: receiver.url(), eventTypes: ['*'], tenant: 'shop-1', secret: STANDARD_SECRET });
    await request(sender.server()).post('/orders/o-1/ship').send({ tenant: 'shop-1' }).expect(201);
    await sender.relay.runOnce();

    const claimed = await sender.app.get(WebhooksStorage).deliveries.claimDeliveries({ owner: 'crashed-worker', now: Date.now(), leaseMs: 30_000, limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(await sender.deliveries.stats()).toMatchObject({ pending: 1, due: 0, leased: 1 });
    expect(await sender.worker.runOnce()).toMatchObject({ claimed: 0 });

    clock.advance(30_000);
    expect(await sender.worker.runOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(receiver.partner.hits).toHaveLength(1);
  });
});
