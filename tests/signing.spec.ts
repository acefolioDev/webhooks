/**
 * The three built-in schemes against their published test vectors: Standard Webhooks (the
 * reference JavaScript library's tests, libraries/javascript/src/webhook.test.ts), GitHub
 * (docs.github.com, "Validating webhook deliveries"), and Stripe (its documented algorithm,
 * stripe-node's Webhooks.ts; Stripe publishes no fixed vector).
 */
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { OutboxModule } from '@nestjs/outbox';
import { signWebhook } from '../lib/testing/index.js';
import { GitHubScheme } from '../lib/signing/github.scheme.js';
import { StripeScheme } from '../lib/signing/stripe.scheme.js';
import { signStandard, StandardWebhooksScheme } from '../lib/signing/standard-webhooks.scheme.js';
import { standardSecretKey } from '../lib/signing/secrets.util.js';
import { WebhooksModule, WebhookVerifier, WebhookVerificationError, WebhooksEvents, type WebhooksEvent } from '../lib/index.js';

// The Standard Webhooks reference vector.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const MSG_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const PAYLOAD = '{"test": 2432232314}';

describe('Standard Webhooks signing', () => {
  it('matches the reference vector', () => {
    expect(`v1,${signStandard(standardSecretKey(SECRET), MSG_ID, 1614265330, PAYLOAD)}`).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });

  it('accepts the secret with and without its whsec_ prefix, and refuses malformed ones', () => {
    expect(standardSecretKey(SECRET)).toEqual(standardSecretKey(SECRET.slice(6)));
    expect(() => standardSecretKey('')).toThrow(/empty/);
    expect(() => standardSecretKey('whsec_')).toThrow();
    expect(() => standardSecretKey(`${SECRET}\n`)).toThrow(/whitespace/);
    expect(() => standardSecretKey('whsec_not base64!')).toThrow(/base64/);
    expect(() => standardSecretKey(`whsec_${Buffer.alloc(16).toString('base64')}`)).toThrow(/24 to 64 bytes/);
    expect(() => standardSecretKey(`whsec_${Buffer.alloc(65).toString('base64')}`)).toThrow(/24 to 64 bytes/);
  });
});

describe('the built-in schemes', () => {
  const standard = new StandardWebhooksScheme();
  const key = standardSecretKey(SECRET);
  const now = () => Math.floor(Date.now() / 1000);
  const headers = (timestamp = now(), signature?: string) => ({
    'webhook-id': MSG_ID,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature ?? `v1,${signStandard(key, MSG_ID, timestamp, PAYLOAD)}`,
  });
  const verify = (h: Record<string, string | string[] | undefined>, body = PAYLOAD) =>
    standard.verify({ headers: h, rawBody: Buffer.from(body) }, [key]);

  // The reference library's cases, one by one.
  it.each([
    ['missing id', { 'webhook-id': undefined }, 'missing-header'],
    ['missing timestamp', { 'webhook-timestamp': undefined }, 'missing-header'],
    ['invalid timestamp', { 'webhook-timestamp': 'hello' }, 'malformed-header'],
    ['missing signature', { 'webhook-signature': undefined }, 'missing-header'],
    ['invalid signature', { 'webhook-signature': 'v1,dawfeoifkpqwoekfpqoekf' }, 'invalid-signature'],
    ['partial signature', { 'webhook-signature': 'v1,g0hM9S' }, 'invalid-signature'],
    ['empty v1 signature', { 'webhook-signature': 'v1,' }, 'invalid-signature'],
    ['a v2 signature only', { 'webhook-signature': 'v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=' }, 'invalid-signature'],
    ['a repeated header', { 'webhook-id': [MSG_ID, 'msg_other'] }, 'malformed-header'],
  ])('refuses a %s', (_name, override, reason) => {
    const result = verify({ ...headers(), ...override });
    expect(result).toMatchObject({ valid: false, reason });
  });

  it('accepts a valid signature among several (rotation)', () => {
    const valid = headers()['webhook-signature'];
    const result = verify({
      ...headers(),
      'webhook-signature': ['v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=', 'v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=', valid].join(' '),
    });
    expect(result).toEqual({ valid: true, id: MSG_ID, timestamp: expect.any(Number) });
  });

  it('signs the id and the timestamp too: changing either breaks the signature', () => {
    const h = headers();
    expect(verify({ ...h, 'webhook-id': 'msg_other' })).toMatchObject({ valid: false, reason: 'invalid-signature' });
    expect(verify({ ...h, 'webhook-timestamp': String(Number(h['webhook-timestamp']) + 1) })).toMatchObject({ valid: false });
    expect(verify(h, `${PAYLOAD} `)).toMatchObject({ valid: false, reason: 'invalid-signature' });
  });

  it('verifies an empty body', () => {
    const t = now();
    expect(verify({ ...headers(t), 'webhook-signature': `v1,${signStandard(key, MSG_ID, t, '')}` }, '')).toMatchObject({ valid: true });
  });

  it('Stripe: hex HMAC-SHA256 of "t.body" keyed with the secret text, several v1 entries', () => {
    const secret = 'whsec_stripe_test_secret';
    const stripe = new StripeScheme();
    const t = 1_700_000_000;
    // The documented algorithm, computed independently of the scheme.
    const expected = createHmac('sha256', secret).update(`${t}.${PAYLOAD}`, 'utf8').digest('hex');
    // A fixed vector, so a change in the algorithm shows here too.
    expect(expected).toBe('066678f7beae483234c2dbeef69c2e9d9b7883dcbfdddfcae6889a8439380beb');
    const check = (value: string) =>
      stripe.verify({ headers: { 'stripe-signature': value }, rawBody: Buffer.from(PAYLOAD) }, [Buffer.from(secret)]);
    expect(check(`t=${t},v1=${expected}`)).toEqual({ valid: true, timestamp: t });
    expect(check(`t=${t},v1=${'0'.repeat(64)},v1=${expected},v0=deadbeef`)).toMatchObject({ valid: true });
    expect(check(`t=${t + 1},v1=${expected}`)).toMatchObject({ valid: false, reason: 'invalid-signature' });
    expect(check(`v1=${expected}`)).toMatchObject({ valid: false, reason: 'malformed-header' });
    expect(check(`t=${t},t=${t},v1=${expected}`)).toMatchObject({ valid: false, reason: 'malformed-header' });
    expect(check(`t=${t},v0=${expected}`)).toMatchObject({ valid: false, reason: 'invalid-signature' });

    expect(stripe.verify({ headers: {}, rawBody: Buffer.from(PAYLOAD) }, [Buffer.from(secret)])).toMatchObject({ reason: 'missing-header' });
    expect(stripe.idFromPayload({ id: 'evt_1' })).toBe('evt_1');
  });

  it("GitHub: matches the docs' vector", () => {
    const github = new GitHubScheme();
    const result = github.verify(
      {
        headers: {
          'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
          'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        },
        rawBody: Buffer.from('Hello, World!'),
      },
      [Buffer.from("It's a Secret to Everybody")],
    );
    expect(result).toEqual({ valid: true, id: '72d3162e-cc78-11e3-81ab-4c9367dc0958' });
    expect(
      github.verify({ headers: { 'x-hub-signature-256': 'sha1=abc' }, rawBody: Buffer.from('x') }, [Buffer.from('s')]),
    ).toMatchObject({ reason: 'malformed-header' });
  });

  it('signWebhook() signs what each scheme verifies', () => {
    const body = { id: 'evt_42', type: 'payment.succeeded' };
    const s = signWebhook({ scheme: 'standard', secret: SECRET, payload: body, id: 'msg_1' });
    expect(new StandardWebhooksScheme().verify({ headers: s.headers, rawBody: Buffer.from(s.body) }, [key])).toMatchObject({
      valid: true,
      id: 'msg_1',
    });
    const st = signWebhook({ scheme: 'stripe', secret: 'shh', payload: body, header: 'ShipCo-Signature' });
    expect(new StripeScheme('shipco-signature').verify({ headers: st.headers, rawBody: Buffer.from(st.body) }, [Buffer.from('shh')])).toMatchObject({
      valid: true,
    });
    const gh = signWebhook({ scheme: 'github', secret: 'shh', payload: body, id: 'd-1' });
    expect(new GitHubScheme().verify({ headers: gh.headers, rawBody: Buffer.from(gh.body) }, [Buffer.from('shh')])).toEqual({
      valid: true,
      id: 'd-1',
    });
  });
});

describe('WebhookVerifier', () => {
  async function verifier(receivers: NonNullable<Parameters<typeof WebhooksModule.forRoot>[0]>['receivers']) {
    const moduleRef = await Test.createTestingModule({
      imports: [OutboxModule.forRoot({ relay: { enabled: false } }), WebhooksModule.forRoot({ outgoing: false, receivers })],
    }).compile();
    await moduleRef.init();
    const events: WebhooksEvent[] = [];
    moduleRef.get(WebhooksEvents).events$.subscribe((e) => events.push(e));
    return { verifier: moduleRef.get(WebhookVerifier), events, close: () => moduleRef.close() };
  }

  it('checks the timestamp against the tolerance, in both directions', async () => {
    const { verifier: v, events, close } = await verifier({ payfast: { scheme: 'standard', secret: SECRET, tolerance: '5m' } });
    const at = (offsetMs: number) => signWebhook({ scheme: 'standard', secret: SECRET, payload: { a: 1 }, timestamp: new Date(Date.now() + offsetMs) });
    for (const offset of [-4 * 60_000, 4 * 60_000]) {
      const s = at(offset);
      expect(v.verify('payfast', { headers: s.headers, rawBody: s.body }).payload).toEqual({ a: 1 });
    }
    for (const offset of [-6 * 60_000, 6 * 60_000]) {
      const s = at(offset);
      expect(() => v.verify('payfast', { headers: s.headers, rawBody: s.body })).toThrow(
        expect.objectContaining({ reason: 'timestamp-out-of-tolerance', status: 401 }),
      );
    }

    expect(events).toEqual([
      { type: 'verification-failed', receiver: 'payfast', reason: 'timestamp-out-of-tolerance' },
      { type: 'verification-failed', receiver: 'payfast', reason: 'timestamp-out-of-tolerance' },
    ]);
    await close();
  });

  it('tries every configured secret (the sender rotating), and reads headers in any case', async () => {
    const next = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
    const { verifier: v, close } = await verifier({ payfast: { scheme: 'standard', secret: [next, SECRET] } });
    const s = signWebhook({ scheme: 'standard', secret: SECRET, payload: { ok: true }, id: 'msg_x' });
    const upper = Object.fromEntries(Object.entries(s.headers).map(([k, value]) => [k.toUpperCase(), value]));
    const webhook = v.verify('payfast', { headers: upper, rawBody: Buffer.from(s.body) });
    expect(webhook).toMatchObject({ receiver: 'payfast', id: 'msg_x', payload: { ok: true } });
    expect(webhook.timestamp).toBeInstanceOf(Date);
    expect(v.verify('payfast', { headers: new Headers(s.headers), rawBody: s.body }).id).toBe('msg_x');
    await close();
  });

  it('refuses a validly signed body that is not JSON with a 400, and a receiver that does not exist', async () => {
    const { verifier: v, close } = await verifier({ payfast: { scheme: 'standard', secret: SECRET } });
    const s = signWebhook({ scheme: 'standard', secret: SECRET, payload: 'not json' });
    let error: unknown;
    try {
      v.verify('payfast', { headers: s.headers, rawBody: s.body });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error).toMatchObject({ status: 400, reason: 'invalid-payload' });
    expect(() => v.verify('stripe', { headers: s.headers, rawBody: s.body })).toThrow(/Unknown webhook receiver "stripe". Configured: payfast/);
    await close();
  });

  it("uses Stripe's event id from the signed payload, and a custom id function", async () => {
    const { verifier: v, close } = await verifier({
      shipco: { scheme: 'stripe', header: 'ShipCo-Signature', secret: 'shipco_secret' },
      gh: { scheme: 'github', secret: 'gh', id: (payload: { delivery: string }) => payload.delivery },
    });
    const s = signWebhook({ scheme: 'stripe', header: 'ShipCo-Signature', secret: 'shipco_secret', payload: { id: 'evt_9', type: 'x' } });
    expect(v.verify('shipco', { headers: s.headers, rawBody: s.body }).id).toBe('evt_9');
    const noId = signWebhook({ scheme: 'stripe', header: 'ShipCo-Signature', secret: 'shipco_secret', payload: { type: 'x' } });
    expect(() => v.verify('shipco', { headers: noId.headers, rawBody: noId.body })).toThrow(expect.objectContaining({ reason: 'missing-header' }));
    const g = signWebhook({ scheme: 'github', secret: 'gh', payload: { delivery: 'from-payload' }, id: 'from-header' });
    expect(v.verify('gh', { headers: g.headers, rawBody: g.body }).id).toBe('from-payload');
    expect(v.verify('gh', { headers: g.headers, rawBody: g.body }).timestamp).toBeNull();
    await close();
  });
});
