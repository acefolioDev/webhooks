/**
 * Both directions over real HTTP: one app sends through the default transport, another
 * (Express, then Fastify) verifies with `@VerifyWebhook()` and deduplicates. What a partner
 * of the store runs, and what the store runs for its payment provider.
 */
import { Controller, HttpCode, Injectable, Module, Post, type INestApplication } from '@nestjs/common';
import { OutboxModule } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { adapters } from './support/adapters.js';
import { IncomingWebhook, VerifyWebhook, WebhooksModule } from '../lib/index.js';
import { controllableClock, sendingApp, sleep } from './helpers.js';

const SECRET = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
const NEXT = `whsec_${Buffer.alloc(32, 4).toString('base64')}`;

@Injectable()
class Received {
  readonly webhooks: { id: string; type: string; data: unknown }[] = [];
}

@Controller('store')
class PartnerController {
  constructor(private readonly received: Received) {}

  @Post('webhooks')
  @HttpCode(204)
  @VerifyWebhook('store')
  receive(@IncomingWebhook() webhook: IncomingWebhook<{ type: string; data: unknown }>) {
    this.received.webhooks.push({ id: webhook.id, type: webhook.payload.type, data: webhook.payload.data });
  }

  @Post('slow')
  @VerifyWebhook('store')
  async slow() {
    await sleep(1_000);
  }
}

function partnerModule(secrets: string[]) {
  @Module({
    imports: [
      OutboxModule.forRoot({ relay: { enabled: false } }),
      WebhooksModule.forRoot({ outgoing: false, receivers: { store: { scheme: 'standard', secret: secrets } } }),
    ],
    controllers: [PartnerController],
    providers: [Received],
  })
  class PartnerModule {}
  return PartnerModule;
}

describe.each(adapters.map((a) => a.name))('delivering to a partner running %s', (adapter) => {
  let partner: INestApplication;
  let url: string;

  async function startPartner(secrets: string[]) {
    const moduleRef = await Test.createTestingModule({ imports: [partnerModule(secrets)] }).compile();
    partner = moduleRef.createNestApplication(adapters.find((a) => a.name === adapter)!.create() as never, { rawBody: true, logger: false });
    await partner.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(partner.getHttpServer().address() as AddressInfo).port}`;
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    await partner?.close();
  });

  const sender = (options: Parameters<typeof sendingApp>[0] = {}) =>
    sendingApp({
      // Development settings: the partner runs on this machine.
      delivery: { allowHttp: true, allowPrivateNetworks: true, timeout: '500ms' },
      retry: { attempts: 3, backoff: { delay: '1s', jitter: 'none' } },
      transport: undefined,
      ...options,
    });

  it('sends a signed webhook the partner verifies, once, and logs the response', async () => {
    await startPartner([SECRET]);
    const store = await sender();
    const endpoint = await store.endpoints.create({ url: `${url}/store/webhooks`, eventTypes: ['*'], tenant: 'shop-1', secret: SECRET });
    const message = await store.transaction((tx) => store.webhooks.dispatch(tx, { type: 'order.shipped', tenant: 'shop-1', data: { orderId: 'o-1' } }));
    expect(await store.flush()).toMatchObject({ delivered: 1 });
    expect(partner.get(Received).webhooks).toEqual([{ id: message.id, type: 'order.shipped', data: { orderId: 'o-1' } }]);

    // A replay reaches the partner with the same id, and its inbox skips it.
    const [delivery] = await store.deliveries.list({ endpointId: endpoint.id });
    await store.deliveries.retry(delivery!.id);
    await store.worker.runOnce();
    expect(partner.get(Received).webhooks).toHaveLength(1);

    const details = await store.deliveries.get(delivery!.id);
    expect(details!.history.map((a) => a.statusCode)).toEqual([204, 204]); // the route's status, handler or not
    await store.close();
  });

  it('keeps delivering through a secret rotation: the partner switches secrets during the overlap', async () => {
    const clock = controllableClock();
    await startPartner([SECRET]);
    const store = await sender({ secretRotationOverlap: '1h' });
    const endpoint = await store.endpoints.create({ url: `${url}/store/webhooks`, eventTypes: ['*'], secret: SECRET });
    await store.endpoints.rotateSecret(endpoint.id, { secret: NEXT });
    const send = async () => {
      await store.transaction((tx) => store.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
      return store.flush();
    };
    expect(await send()).toMatchObject({ delivered: 1 }); // the partner still has the old secret only
    await partner.close();
    await startPartner([NEXT]); // it deploys the new one (on another port here)
    await store.endpoints.update(endpoint.id, { url: `${url}/store/webhooks` });
    expect(await send()).toMatchObject({ delivered: 1 });
    clock.advance(60 * 60_000 + 1);
    expect(await send()).toMatchObject({ delivered: 1 });
    await partner.close();
    await startPartner([SECRET]); // an old deployment, after the overlap: refused
    await store.endpoints.update(endpoint.id, { url: `${url}/store/webhooks` });
    expect(await send()).toMatchObject({ retried: 1 });
    expect((await store.deliveries.list({ status: 'pending' }))[0]!.lastStatusCode).toBe(401);
    await store.close();
  });

  it('retries when the partner is down, and times out a slow partner', async () => {
    await startPartner([SECRET]);
    const store = await sender();
    await store.endpoints.create({ url: `${url}/store/slow`, eventTypes: ['slow.one'], secret: SECRET });
    await store.endpoints.create({ url: 'http://127.0.0.1:9/unreachable', eventTypes: ['down.one'], secret: SECRET });
    await store.transaction((tx) => store.webhooks.dispatch(tx, [{ type: 'slow.one', data: {} }, { type: 'down.one', data: {} }]));
    expect(await store.flush()).toMatchObject({ retried: 2 });

    const errors = (await store.deliveries.list({})).map((d) => d.lastError).sort();
    expect(errors).toEqual([expect.stringMatching(/ECONNREFUSED/), 'WebhookDeliveryTimeoutError: No response within 500ms']);
    await store.close();
  });
});
