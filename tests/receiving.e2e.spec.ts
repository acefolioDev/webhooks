/**
 * Receiving, beyond the happy paths in incoming.e2e.spec.ts: which receiver a route uses
 * when the controller and the method name different ones, receivers sharing an inbox
 * consumer, form-encoded bodies, Stripe and GitHub refusals over HTTP, and the decorators'
 * misuse. Then `WebhookVerifier` on its own: custom schemes, ids, and the inbox.
 */
import { Controller, Get, HttpCode, Injectable, Module, Post, type INestApplication } from '@nestjs/common';
import { InMemoryOutboxStore, OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
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
  WebhookVerificationError,
  WebhookVerifier,
  type WebhookReceiverOptions,
  type WebhookSignatureCheck,
  type WebhookSignedRequest,
  type WebhooksEvent,
} from '../lib/index.js';

const ALPHA = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
const BETA = `whsec_${Buffer.alloc(32, 2).toString('base64')}`;
const STRIPE = 'whsec_stripe_like_secret';
const GITHUB = 'gh-secret';

const standard = (secret: string, id: string) => signWebhook({ scheme: 'standard', secret, payload: { type: 'a.b' }, id });

@Injectable()
class Seen {
  readonly calls: { route: string; receiver: string; id: string }[] = [];
}

@Controller('alpha')
@VerifyWebhook('alpha')
class AlphaController {
  constructor(private readonly seen: Seen) {}

  @Post('own')
  @HttpCode(200)
  own(@IncomingWebhook() webhook: IncomingWebhook) {
    this.seen.calls.push({ route: 'own', receiver: webhook.receiver, id: webhook.id });
  }

  @Post('beta')
  @HttpCode(200)
  @VerifyWebhook('beta')
  beta(@IncomingWebhook() webhook: IncomingWebhook) {
    this.seen.calls.push({ route: 'beta', receiver: webhook.receiver, id: webhook.id });
  }
}

@Controller('hooks')
class HooksController {
  constructor(private readonly seen: Seen) {}

  @Post('shared-a')
  @HttpCode(200)
  @VerifyWebhook('shared-a')
  sharedA(@IncomingWebhook() webhook: IncomingWebhook) {
    this.seen.calls.push({ route: 'shared-a', receiver: webhook.receiver, id: webhook.id });
  }

  @Post('shared-b')
  @HttpCode(200)
  @VerifyWebhook('shared-b')
  sharedB(@IncomingWebhook() webhook: IncomingWebhook) {
    this.seen.calls.push({ route: 'shared-b', receiver: webhook.receiver, id: webhook.id });
  }

  @Post('stripe')
  @HttpCode(200)
  @VerifyWebhook('stripe')
  stripe(@IncomingWebhook() webhook: IncomingWebhook) {
    this.seen.calls.push({ route: 'stripe', receiver: webhook.receiver, id: webhook.id });
  }

  @Post('github')
  @HttpCode(204)
  @VerifyWebhook('github')
  github(@IncomingWebhook() webhook: IncomingWebhook) {
    this.seen.calls.push({ route: 'github', receiver: webhook.receiver, id: webhook.id });
  }

  @Post('unverified')
  unverified(@WebhookPayload() payload: unknown) {
    return payload;
  }

  @Get('health')
  health() {
    return 'ok';
  }
}

@Module({
  imports: [
    OutboxModule.forRoot({ relay: { enabled: false } }),
    WebhooksModule.forRoot({
      outgoing: false,
      receivers: {
        alpha: { scheme: 'standard', secret: ALPHA },
        beta: { scheme: 'standard', secret: BETA },
        // Two endpoints of one sender: one id space.
        'shared-a': { scheme: 'standard', secret: ALPHA, consumer: 'payments' },
        'shared-b': { scheme: 'standard', secret: BETA, consumer: 'payments' },
        stripe: { scheme: 'stripe', secret: STRIPE, tolerance: '1m' },
        github: { scheme: 'github', secret: GITHUB },
      },
    }),
  ],
  controllers: [AlphaController, HooksController],
  providers: [Seen],
})
class ReceiverModule {}

describe.each(adapters.map((a) => a.name))('receiving on %s', (adapter: AdapterName) => {
  let app: INestApplication;
  let seen: Seen;
  const events: WebhooksEvent[] = [];

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReceiverModule] }).compile();
    app = moduleRef.createNestApplication(adapters.find((a) => a.name === adapter)!.create() as never, { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    seen = app.get(Seen);
    events.length = 0;
    app.get(WebhooksEvents).events$.subscribe((e) => events.push(e));
  });
  afterEach(() => app.close());

  const post = (path: string, signed: { body: string; headers: Record<string, string> }) =>
    request(app.getHttpServer()).post(path).set(signed.headers).send(signed.body);

  it("uses the method's receiver over the controller's", async () => {
    await post('/alpha/own', standard(ALPHA, 'msg_1')).expect(200);
    await post('/alpha/own', standard(BETA, 'msg_2')).expect(401);
    await post('/alpha/beta', standard(BETA, 'msg_3')).expect(200);
    await post('/alpha/beta', standard(ALPHA, 'msg_4')).expect(401);
    expect(seen.calls).toEqual([
      { route: 'own', receiver: 'alpha', id: 'msg_1' },
      { route: 'beta', receiver: 'beta', id: 'msg_3' },
    ]);
  });

  it('shares one id space between receivers with the same consumer, and keeps the others apart', async () => {
    await post('/hooks/shared-a', standard(ALPHA, 'msg_same')).expect(200);
    await post('/hooks/shared-b', standard(BETA, 'msg_same')).expect(200, '');
    await post('/alpha/own', standard(ALPHA, 'msg_same')).expect(200);
    expect(seen.calls.map((c) => c.route)).toEqual(['shared-a', 'own']);
  });

  it('verifies a form-encoded body on its raw bytes, and answers 400 when the signed body is not JSON', async () => {
    const signed = signWebhook({ scheme: 'standard', secret: ALPHA, payload: 'type=a.b&amount=1', id: 'msg_form' });
    const response = await post('/alpha/own', { ...signed, headers: { ...signed.headers, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ statusCode: 400, message: 'Webhook payload is not valid JSON' });
    expect(events).toEqual([{ type: 'verification-failed', receiver: 'alpha', reason: 'invalid-payload' }]);
    expect(seen.calls).toEqual([]);
  });

  it("refuses a Stripe signature older than the receiver's tolerance, and a tampered one", async () => {
    const payload = { id: 'evt_1', type: 'charge.succeeded' };
    await post('/hooks/stripe', signWebhook({ scheme: 'stripe', secret: STRIPE, payload, timestamp: new Date(Date.now() - 50_000) })).expect(200);
    await post('/hooks/stripe', signWebhook({ scheme: 'stripe', secret: STRIPE, payload: { ...payload, id: 'evt_2' }, timestamp: new Date(Date.now() - 70_000) })).expect(401);
    const tampered = signWebhook({ scheme: 'stripe', secret: STRIPE, payload: { ...payload, id: 'evt_3' } });
    await post('/hooks/stripe', { ...tampered, body: tampered.body.replace('evt_3', 'evt_4') }).expect(401);
    expect(seen.calls.map((c) => c.id)).toEqual(['evt_1']);
    expect(events.map((e) => (e.type === 'verification-failed' ? e.reason : e.type))).toEqual(['timestamp-out-of-tolerance', 'invalid-signature']);
  });

  it('refuses a GitHub delivery without its delivery id, since there is nothing to deduplicate on', async () => {
    const signed = signWebhook({ scheme: 'github', secret: GITHUB, payload: { action: 'opened' }, id: 'gh-1' });
    await post('/hooks/github', signed).expect(204);
    const { 'x-github-delivery': _id, ...headers } = signed.headers;
    await post('/hooks/github', { body: signed.body, headers }).expect(401);
    expect(events).toEqual([{ type: 'verification-failed', receiver: 'github', reason: 'missing-header' }]);
    // A captured GitHub delivery replays forever: only the inbox stops it.
    await post('/hooks/github', signed).expect(204);
    expect(seen.calls.map((c) => c.id)).toEqual(['gh-1']);
  });

  it('answers 500 when @WebhookPayload() is used without @VerifyWebhook(), and leaves other routes alone', async () => {
    await post('/hooks/unverified', standard(ALPHA, 'msg_x')).expect(500);
    await request(app.getHttpServer()).get('/hooks/health').expect(200, 'ok');
  });
});

describe('WebhookVerifier', () => {
  /** Signs `ts.body` with HMAC-SHA256 in hex, the key being the secret reversed: a scheme with its own key(). */
  class ReversedKeyScheme extends WebhookSignatureScheme {
    override key(secret: string): Buffer {
      if (!secret.startsWith('rk_')) {
        throw new TypeError('a ReversedKey secret starts with rk_');
      }
      return Buffer.from([...secret].reverse().join(''));
    }

    verify({ headers, rawBody }: WebhookSignedRequest, keys: readonly Buffer[]): WebhookSignatureCheck {
      const [ts, signature] = String(headers['x-rk'] ?? '').split(':');
      if (!ts || !signature) {
        return { valid: false, reason: 'missing-header', detail: 'no x-rk' };
      }
      for (const key of keys) {
        if (WebhookSignatureScheme.matches(sign(key, ts, rawBody), [Buffer.from(signature, 'hex')])) {
          return { valid: true, timestamp: Number(ts) };
        }
      }
      return { valid: false, reason: 'invalid-signature', detail: 'no match' };
    }

    override idFromPayload(payload: unknown): string | undefined {
      return (payload as { ref?: string } | undefined)?.ref;
    }
  }
  const sign = (key: Buffer, ts: string, body: Buffer | string) => createHmac('sha256', key).update(`${ts}.`).update(body).digest();

  async function verifier(receivers: Record<string, WebhookReceiverOptions>, outbox = true) {
    const moduleRef = await Test.createTestingModule({
      imports: [...(outbox ? [OutboxModule.forRoot({ relay: { enabled: false } })] : []), WebhooksModule.forRoot({ outgoing: false, receivers })],
    }).compile();
    await moduleRef.init();
    return { verifier: moduleRef.get(WebhookVerifier), moduleRef, close: () => moduleRef.close() };
  }

  it("uses a custom scheme's key() and idFromPayload(), and applies the tolerance to its timestamp", async () => {
    const { verifier: v, close } = await verifier({ partner: { scheme: new ReversedKeyScheme(), secret: 'rk_abc', tolerance: '30s' } });
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ ref: 'ref-7' });
    const headers = (ts: number, key = 'cba_kr') => ({ 'x-rk': `${ts}:${sign(Buffer.from(key), String(ts), body).toString('hex')}` });

    expect(v.verify('partner', { headers: headers(now), rawBody: body })).toMatchObject({ id: 'ref-7', timestamp: new Date(now * 1000) });
    expect(() => v.verify('partner', { headers: headers(now, 'rk_abc'), rawBody: body })).toThrow(expect.objectContaining({ reason: 'invalid-signature' }));
    expect(() => v.verify('partner', { headers: headers(now - 60), rawBody: body })).toThrow(expect.objectContaining({ reason: 'timestamp-out-of-tolerance' }));
    await close();

    await expect(verifier({ partner: { scheme: new ReversedKeyScheme(), secret: 'abc' } })).rejects.toThrow(
      'WebhooksModule: receivers.partner.secret: a ReversedKey secret starts with rk_',
    );
  });

  it('takes the raw body as a string or a Buffer, and nothing else', async () => {
    const { verifier: v, close } = await verifier({ alpha: { scheme: 'standard', secret: ALPHA } });
    const s = signWebhook({ scheme: 'standard', secret: ALPHA, payload: { n: 'ü' }, id: 'msg_1' });
    expect(v.verify('alpha', { headers: s.headers, rawBody: s.body }).rawBody).toEqual(Buffer.from(s.body));
    expect(v.verify('alpha', { headers: s.headers, rawBody: Buffer.from(s.body) }).payload).toEqual({ n: 'ü' });
    expect(() => v.verify('alpha', { headers: s.headers, rawBody: JSON.parse(s.body) })).toThrow(/rawBody must be the body as received/);
    expect(v.receivers).toEqual(['alpha']);
    await close();
  });

  it('verifies an empty body as an undefined payload', async () => {
    const { verifier: v, close } = await verifier({ alpha: { scheme: 'standard', secret: ALPHA } });
    const s = signWebhook({ scheme: 'standard', secret: ALPHA, payload: '', id: 'msg_ping' });
    expect(v.verify('alpha', { headers: s.headers, rawBody: '' })).toMatchObject({ id: 'msg_ping', payload: undefined });
    await close();
  });

  it('refuses an id that is empty or longer than 256 characters, from a header or an id function', async () => {
    const { verifier: v, close } = await verifier({
      github: { scheme: 'github', secret: GITHUB },
      custom: { scheme: 'github', secret: GITHUB, id: (payload: { ref: string }) => payload.ref },
    });
    const long = signWebhook({ scheme: 'github', secret: GITHUB, payload: { ref: '' }, id: 'd'.repeat(257) });
    expect(() => v.verify('github', { headers: long.headers, rawBody: long.body })).toThrow(expect.objectContaining({ reason: 'missing-header', status: 401 }));
    const exact = signWebhook({ scheme: 'github', secret: GITHUB, payload: { ref: '' }, id: 'd'.repeat(256) });
    expect(v.verify('github', { headers: exact.headers, rawBody: exact.body }).id).toHaveLength(256);
    // The id function's empty string is an answer, not a fall-through to the header.
    expect(() => v.verify('custom', { headers: exact.headers, rawBody: exact.body })).toThrow(WebhookVerificationError);
    await close();
  });

  it("uses the Stripe id function over the payload's id", async () => {
    const { verifier: v, close } = await verifier({ stripe: { scheme: 'stripe', secret: STRIPE, id: (payload: { data: { object: { id: string } } }) => payload.data.object.id } });
    const s = signWebhook({ scheme: 'stripe', secret: STRIPE, payload: { id: 'evt_1', data: { object: { id: 'pi_9' } } } });
    expect(v.verify('stripe', { headers: s.headers, rawBody: s.body }).id).toBe('pi_9');
    await close();
  });

  it('publishes refusals on the diagnostics channel, with the reason and not the detail', async () => {
    const { verifier: v, close } = await verifier({ alpha: { scheme: 'standard', secret: ALPHA } });
    const seen: unknown[] = [];
    const listener = (event: unknown) => seen.push(event);
    subscribe('nestjs:webhooks:verification-failed', listener);
    try {
      const s = standard(ALPHA, 'msg_1');
      expect(() => v.verify('alpha', { headers: { ...s.headers, 'webhook-timestamp': 'yesterday' }, rawBody: s.body })).toThrow(
        'Webhook from "alpha" refused (malformed-header): webhook-timestamp is not a number of seconds',
      );
    } finally {
      unsubscribe('nestjs:webhooks:verification-failed', listener);
    }
    expect(seen).toEqual([{ type: 'verification-failed', receiver: 'alpha', reason: 'malformed-header' }]);
    await close();
  });

  it('records ids with processInTransaction() in the inbox, and says what it needs without one', async () => {
    const withInbox = await verifier({ alpha: { scheme: 'standard', secret: ALPHA } });
    const s = standard(ALPHA, 'msg_tx');
    const webhook = withInbox.verifier.verify('alpha', { headers: s.headers, rawBody: s.body });
    const inbox = withInbox.moduleRef.get(OutboxStorage).inbox as InMemoryOutboxStore;
    let effects = 0;
    expect(await inbox.transaction((tx) => webhook.processInTransaction(tx, () => ++effects))).toEqual({ duplicate: false, result: 1 });
    // The same id verified again (a redelivery): the inbox has it.
    const again = withInbox.verifier.verify('alpha', { headers: s.headers, rawBody: s.body });
    expect(await inbox.transaction((tx) => again.processInTransaction(tx, () => ++effects))).toEqual({ duplicate: true });
    expect(effects).toBe(1);
    await withInbox.close();

    const without = await verifier({ alpha: { scheme: 'standard', secret: ALPHA, dedupe: false } }, false);
    const alone = without.verifier.verify('alpha', { headers: s.headers, rawBody: s.body });
    expect(alone.id).toBe(webhook.id);
    expect(() => alone.processInTransaction({}, () => 1)).toThrow(/Webhook deduplication needs @nestjs\/outbox/);
    await without.close();
  });
});
