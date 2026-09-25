/**
 * Receiving on Express and Fastify: `@VerifyWebhook()` on the raw body for each scheme,
 * refusals, deduplication by webhook id through the outbox inbox, exactly-once effects with
 * `processInTransaction()`, and the configuration mistakes that fail loudly.
 */
import { Controller, HttpCode, Injectable, Module, Post, type INestApplication, type Type } from '@nestjs/common';
import { InMemoryOutboxStore, OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { adapters, type AdapterName } from './support/adapters.js';
import { signWebhook } from '../lib/testing/index.js';
import {
  IncomingWebhook,
  VerifyWebhook,
  WebhookPayload,
  WebhooksEvents,
  WebhookSignatureScheme,
  WebhooksModule,
  type WebhookSignatureCheck,
  type WebhookSignedRequest,
  type WebhooksEvent,
} from '../lib/index.js';
import { CapturingLogger, sleep } from './helpers.js';

const PAYMENTS_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const CARRIER_SECRET = 'carrier_live_5b0e1c';
const GITHUB_SECRET = "It's a Secret to Everybody";
const SHOPIFY_SECRET = 'shpss_0123456789';

/** Shopify's scheme, as an app would add it: base64 HMAC-SHA256 of the body, the id in its own header. */
class ShopifyScheme extends WebhookSignatureScheme {
  verify({ headers, rawBody }: WebhookSignedRequest, keys: readonly Buffer[]): WebhookSignatureCheck {
    const signature = headers['x-shopify-hmac-sha256'];
    if (typeof signature !== 'string') {
      return { valid: false, reason: 'missing-header', detail: 'no x-shopify-hmac-sha256' };
    }
    const candidate = [Buffer.from(signature, 'base64')];
    for (const key of keys) {
      if (WebhookSignatureScheme.matches(createHmac('sha256', key).update(rawBody).digest(), candidate)) {
        return { valid: true, id: headers['x-shopify-webhook-id'] as string };
      }
    }
    return { valid: false, reason: 'invalid-signature', detail: 'no match' };
  }
}

interface PaymentEvent {
  type: string;
  data: { orderId: string; amount?: number; fail?: boolean; slow?: boolean };
}

@Injectable()
class Ledger {
  readonly calls: { receiver: string; id: string; payload: unknown }[] = [];
  paid = 0;
}

@Controller('webhooks')
class WebhooksController {
  constructor(private readonly ledger: Ledger) {}

  @Post('payments')
  @HttpCode(200)
  @VerifyWebhook('payments')
  async payments(@WebhookPayload() event: PaymentEvent, @IncomingWebhook() webhook: IncomingWebhook<PaymentEvent>) {
    this.ledger.calls.push({ receiver: webhook.receiver, id: webhook.id, payload: event });
    if (event.data.slow) {
      await sleep(100);
    }
    if (event.data.fail) {
      throw new Error('ledger unavailable');
    }
    return { received: webhook.id };
  }

  @Post('carrier')
  @HttpCode(200)
  @VerifyWebhook('carrier')
  carrier(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.calls.push({ receiver: webhook.receiver, id: webhook.id, payload: webhook.payload });
  }

  @Post('github')
  @HttpCode(204)
  @VerifyWebhook('github')
  github(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.calls.push({ receiver: webhook.receiver, id: webhook.id, payload: webhook.payload });
  }

  @Post('shopify')
  @HttpCode(200)
  @VerifyWebhook('shopify')
  shopify(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.calls.push({ receiver: webhook.receiver, id: webhook.id, payload: webhook.payload });
  }

  @Post('every-time')
  @HttpCode(200)
  @VerifyWebhook('every-time')
  everyTime(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.calls.push({ receiver: webhook.receiver, id: webhook.id, payload: webhook.payload });
  }

  /** Exactly once: the inbox record commits with the ledger write. */
  @Post('payments-tx')
  @HttpCode(200)
  @VerifyWebhook('payments')
  async paymentsInTransaction(@IncomingWebhook() webhook: IncomingWebhook<PaymentEvent>) {
    const store = this.outboxStore();
    const result = await store.transaction((tx) => webhook.processInTransaction(tx, () => (this.ledger.paid += 1)));
    return result;
  }

  outboxStore!: () => InMemoryOutboxStore;
}

@Controller('both')
@VerifyWebhook('payments')
class BothLevelsController {
  constructor(private readonly ledger: Ledger) {}

  @Post()
  @HttpCode(200)
  @VerifyWebhook('payments')
  both(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.calls.push({ receiver: 'both', id: webhook.id, payload: webhook.payload });
  }
}

@Module({
  imports: [
    OutboxModule.forRoot({ relay: { enabled: false } }),
    WebhooksModule.forRoot({
      outgoing: false,
      receivers: {
        payments: { scheme: 'standard', secret: PAYMENTS_SECRET },
        carrier: { scheme: 'stripe', header: 'Carrier-Signature', secret: CARRIER_SECRET },
        github: { scheme: 'github', secret: GITHUB_SECRET },
        shopify: { scheme: new ShopifyScheme(), secret: SHOPIFY_SECRET },
        'every-time': { scheme: 'standard', secret: PAYMENTS_SECRET, dedupe: false },
      },
    }),
  ],
  controllers: [WebhooksController, BothLevelsController],
  providers: [Ledger],
})
class ReceiverModule {}

async function start(adapter: AdapterName, module: Type = ReceiverModule, rawBody = true, logger: CapturingLogger | false = false) {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  const app = moduleRef.createNestApplication(adapters.find((a) => a.name === adapter)!.create() as never, { rawBody, logger });
  await app.listen(0, '127.0.0.1');
  return app;
}

describe.each(adapters.map((a) => a.name))('receiving webhooks on %s', (adapter) => {
  let app: INestApplication;
  let ledger: Ledger;
  const events: WebhooksEvent[] = [];

  beforeEach(async () => {
    app = await start(adapter);
    ledger = app.get(Ledger);
    const controller = app.get(WebhooksController);
    controller.outboxStore = () => app.get(OutboxStorage).inbox as InMemoryOutboxStore;
    events.length = 0;
    app.get(WebhooksEvents).events$.subscribe((e) => events.push(e));
  });
  afterEach(() => app.close());

  const post = (path: string, signed: { body: string; headers: Record<string, string> }) =>
    request(app.getHttpServer()).post(path).set(signed.headers).send(signed.body);
  const payment = (data: PaymentEvent['data'], options: { id?: string; timestamp?: Date; secret?: string } = {}) =>
    signWebhook({ scheme: 'standard', secret: options.secret ?? PAYMENTS_SECRET, payload: { type: 'payment.succeeded', data }, ...options });

  it('verifies the signature on the raw body and hands the handler the parsed payload', async () => {
    // Formatting a re-serialized body would lose: spacing, key order, 1.10.
    const body = '{ "type": "payment.succeeded",\n  "data": { "orderId": "o-1", "amount": 1.10, "note": "\\u00fc" } }';
    const signed = signWebhook({ scheme: 'standard', secret: PAYMENTS_SECRET, payload: body, id: 'msg_1' });
    const response = await post('/webhooks/payments', signed).expect(200);
    expect(response.body).toEqual({ received: 'msg_1' });
    expect(ledger.calls).toEqual([
      { receiver: 'payments', id: 'msg_1', payload: { type: 'payment.succeeded', data: { orderId: 'o-1', amount: 1.1, note: 'ü' } } },
    ]);
  });

  it('refuses a bad signature, a wrong secret, a stale timestamp and missing headers with a 401, without saying why', async () => {
    const valid = payment({ orderId: 'o-1' });
    const cases = [
      { ...valid, body: valid.body.replace('o-1', 'o-2') },
      payment({ orderId: 'o-1' }, { secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` }),
      payment({ orderId: 'o-1' }, { timestamp: new Date(Date.now() - 10 * 60_000) }),
      { ...valid, headers: { 'content-type': 'application/json' } },
    ];
    for (const signed of cases) {
      const response = await post('/webhooks/payments', signed).expect(401);
      expect(response.body).toEqual({ message: 'Webhook signature verification failed', error: 'Unauthorized', statusCode: 401 });
    }

    expect(ledger.calls).toEqual([]);
    expect(events.map((e) => (e.type === 'verification-failed' ? e.reason : e.type))).toEqual([
      'invalid-signature',
      'invalid-signature',
      'timestamp-out-of-tolerance',
      'missing-header',
    ]);
  });

  it('answers a redelivery of a processed webhook id with an empty 2xx, without running the handler', async () => {
    const first = payment({ orderId: 'o-1' }, { id: 'msg_dup' });
    await post('/webhooks/payments', first).expect(200, { received: 'msg_dup' });
    // The sender retries (our 200 was lost): same id, a new timestamp and signature.
    const again = payment({ orderId: 'o-1' }, { id: 'msg_dup', timestamp: new Date(Date.now() + 1_000) });
    const response = await post('/webhooks/payments', again).expect(200);
    expect(response.text).toBe('');
    expect(ledger.calls).toHaveLength(1);
    // Another receiver's id space is its own.
    await post('/webhooks/every-time', payment({ orderId: 'o-1' }, { id: 'msg_dup' })).expect(200);
    expect(ledger.calls).toHaveLength(2);
  });

  it('records the id only after the handler succeeds, so a failed delivery is processed on retry', async () => {
    await post('/webhooks/payments', payment({ orderId: 'o-1', fail: true }, { id: 'msg_retry' })).expect(500);
    await post('/webhooks/payments', payment({ orderId: 'o-1' }, { id: 'msg_retry' })).expect(200);
    await post('/webhooks/payments', payment({ orderId: 'o-1' }, { id: 'msg_retry' })).expect(200, '');
    expect(ledger.calls.map((c) => (c.payload as PaymentEvent).data.fail ?? false)).toEqual([true, false]);
  });

  it('runs the handler once for two copies arriving together', async () => {
    const signed = payment({ orderId: 'o-1', slow: true }, { id: 'msg_race' });
    const [a, b] = await Promise.all([post('/webhooks/payments', signed), post('/webhooks/payments', signed)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(ledger.calls).toHaveLength(1);
  });

  it('makes effects exactly-once with processInTransaction()', async () => {
    const signed = payment({ orderId: 'o-1' }, { id: 'msg_tx' });
    expect((await post('/webhooks/payments-tx', signed).expect(200)).body).toEqual({ duplicate: false, result: 1 });
    await post('/webhooks/payments-tx', signed).expect(200, '');
    expect(ledger.paid).toBe(1);
  });

  it('runs every delivery when the receiver turns deduplication off', async () => {
    const signed = payment({ orderId: 'o-1' }, { id: 'msg_again' });
    await post('/webhooks/every-time', signed).expect(200);
    await post('/webhooks/every-time', signed).expect(200);
    expect(ledger.calls).toHaveLength(2);
  });

  it("verifies the carrier's Stripe-like header, keyed by the signed event id", async () => {
    const signed = signWebhook({
      scheme: 'stripe',
      header: 'Carrier-Signature',
      secret: CARRIER_SECRET,
      payload: { id: 'evt_1', type: 'shipment.delivered', data: { orderId: 'o-1' } },
    });
    await post('/webhooks/carrier', signed).expect(200);
    await post('/webhooks/carrier', signed).expect(200);
    expect(ledger.calls).toEqual([{ receiver: 'carrier', id: 'evt_1', payload: { id: 'evt_1', type: 'shipment.delivered', data: { orderId: 'o-1' } } }]);
    await post('/webhooks/carrier', { ...signed, headers: { ...signed.headers, 'carrier-signature': signed.headers['carrier-signature']!.replace('v1=', 'v1=0') } }).expect(401);
  });

  it("verifies GitHub's signature, and a custom scheme", async () => {
    await post('/webhooks/github', signWebhook({ scheme: 'github', secret: GITHUB_SECRET, payload: { zen: 'Keep it simple.' }, id: 'gh-1' })).expect(204);
    const body = JSON.stringify({ id: 42, topic: 'orders/create' });
    const hmac = createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64');
    await request(app.getHttpServer())
      .post('/webhooks/shopify')
      .set({ 'content-type': 'application/json', 'x-shopify-hmac-sha256': hmac, 'x-shopify-webhook-id': 'shp-1' })
      .send(body)
      .expect(200);
    expect(ledger.calls.map((c) => [c.receiver, c.id])).toEqual([
      ['github', 'gh-1'],
      ['shopify', 'shp-1'],
    ]);
  });

  it('refuses a body the framework would not keep raw (415), and a signed body that is not JSON (400)', async () => {
    const signed = payment({ orderId: 'o-1' });
    await post('/webhooks/payments', { ...signed, headers: { ...signed.headers, 'content-type': 'text/plain' } }).expect(415);
    const notJson = signWebhook({ scheme: 'standard', secret: PAYMENTS_SECRET, payload: 'plain text' });
    // application/json that isn't JSON: the body parser refuses it first.
    const response = await post('/webhooks/payments', notJson);
    expect(response.status).toBe(400);
    expect(ledger.calls).toEqual([]);
  });

  it('verifies once and deduplicates once with @VerifyWebhook() on the controller and the method', async () => {
    const signed = payment({ orderId: 'o-1' }, { id: 'msg_both' });
    await post('/both', signed).expect(200);
    await post('/both', signed).expect(200);
    expect(ledger.calls).toHaveLength(1);
  });
});

describe.each(adapters.map((a) => a.name))('configuration mistakes on %s', (adapter) => {
  it('answers 500 and logs how to fix it when the app was created without rawBody', async () => {
    const logger = new CapturingLogger();
    const app = await start(adapter, ReceiverModule, false, logger);
    try {
      await request(app.getHttpServer())
        .post('/webhooks/payments')
        .set(signWebhook({ scheme: 'standard', secret: PAYMENTS_SECRET, payload: { a: 1 } }).headers)
        .send('{"a":1}')
        .expect(500);
      expect(logger.lines.some((line) => line.includes('NestFactory.create(AppModule, { rawBody: true })'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('startup checks', () => {
  const compile = async (imports: any[], controllers: Type[] = []) => {
    const moduleRef = await Test.createTestingModule({ imports, controllers }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app;
  };

  @Controller()
  class Unknown {
    @Post() @VerifyWebhook('refunds') hook() {}
  }

  it('fails when @VerifyWebhook() names a receiver that is not configured', async () => {
    await expect(
      compile([OutboxModule.forRoot({ relay: { enabled: false } }), WebhooksModule.forRoot({ outgoing: false, receivers: { payments: { scheme: 'standard', secret: PAYMENTS_SECRET } } })], [Unknown]),
    ).rejects.toThrow("Unknown.hook: @VerifyWebhook('refunds') names no receiver. Configured in WebhooksModule `receivers`: payments.");
  });

  @Controller()
  class Payments {
    @Post() @VerifyWebhook('payments') hook() {}
  }

  it('fails when a receiver deduplicates and there is no outbox, or when sending without one', async () => {
    const receivers = { payments: { scheme: 'standard' as const, secret: PAYMENTS_SECRET } };
    await expect(compile([WebhooksModule.forRoot({ outgoing: false, receivers })], [Payments])).rejects.toThrow(
      /Payments.hook: receiver "payments" deduplicates webhook ids with OutboxInbox, from @nestjs\/outbox/,
    );
    const app = await compile([WebhooksModule.forRoot({ outgoing: false, receivers: { payments: { ...receivers.payments, dedupe: false } } })], [Payments]);
    await app.close();
    await expect(compile([WebhooksModule.forRoot({})])).rejects.toThrow(/WebhooksModule needs @nestjs\/outbox to send webhooks/);
  });

  it.each([
    [{ payments: { scheme: 'standard', secret: 'whsec_tooshort' } }, /receivers.payments.secret: a Standard Webhooks secret/],
    [{ payments: { scheme: 'standard', secret: `${PAYMENTS_SECRET}\n` } }, /receivers.payments.secret: the secret starts or ends with whitespace/],
    [{ payments: { scheme: 'standard', secret: [PAYMENTS_SECRET, ''] } }, /receivers.payments.secret\[1\]: the secret is empty/],
    [{ payments: { scheme: 'standard', secret: [] } }, /receivers.payments.secret lists no secret/],
    [{ payments: { scheme: 'hmac', secret: 'x' } }, /receivers.payments.scheme must be "standard", "stripe", "github"/],
    [{ payments: { scheme: ShopifyScheme, secret: 'x' } }, /receivers.payments.scheme is a class; pass an instance/],
    [{ payments: { scheme: 'stripe', secret: 'x', header: 'bad header' } }, /receivers.payments.header must be a header name/],
    [{ payments: { scheme: 'standard', secret: PAYMENTS_SECRET, tolerance: '5 minutes' } }, /receivers.payments.tolerance: Invalid duration/],
    [{ 'pay fast': { scheme: 'github', secret: 'x' } }, /receivers.pay fast: a receiver name/],
  ])('refuses receivers %j', async (receivers, message) => {
    await expect(compile([OutboxModule.forRoot({ relay: { enabled: false } }), WebhooksModule.forRoot({ outgoing: false, receivers: receivers as never })])).rejects.toThrow(message);
  });
});
