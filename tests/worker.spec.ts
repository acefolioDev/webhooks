/**
 * The worker's decisions, attempt by attempt: which statuses deliver, which retry and which
 * pause the endpoint, the retry options (a count, `false`, a backoff function, `retryIf`) and
 * what happens when they throw, `Retry-After` in both forms, transports that throw, leases,
 * concurrency, a store that fails, and shutdown in the middle of a batch.
 */
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  InMemoryWebhookStore,
  NonRetryableWebhookError,
  WebhookEndpointNotFoundError,
  WebhookResponseError,
  WebhooksEvents,
  WebhookTransport,
  type WebhookClaimRequest,
  type WebhookDelivery,
  type WebhookDeliveryUpdate,
  type WebhookRequest,
  type WebhookRetryOptions,
} from '../lib/index.js';
import { CapturingLogger, controllableClock, sendingApp, sleep, useStore } from './helpers.js';

const noJitter: WebhookRetryOptions = { attempts: 3, backoff: { delay: '1s', factor: 2, jitter: 'none' } };

afterEach(() => vi.restoreAllMocks());

describe('how a response decides the outcome', () => {
  it('delivers on any 2xx, and retries every other status, redirects included', async () => {
    const t = await sendingApp({ retry: noJitter });
    const statuses = [200, 201, 204, 299, 100, 301, 302, 304, 400, 401, 404, 422, 500];
    for (const status of statuses) {
      await t.endpoints.create({ url: `https://s${status}.example/`, eventTypes: ['*'] });
    }
    t.transport.respondWith((request) => ({ statusCode: Number(new URL(request.url).hostname.slice(1, 4)), headers: { location: 'https://127.0.0.1/' } }));
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));

    expect(await t.flush()).toMatchObject({ claimed: statuses.length, delivered: 4, retried: statuses.length - 4, failed: 0 });
    const byStatus = Object.fromEntries((await t.deliveries.list({})).map((d) => [d.lastStatusCode, d.status]));
    expect(byStatus).toEqual({
      200: 'succeeded',
      201: 'succeeded',
      204: 'succeeded',
      299: 'succeeded',
      100: 'pending',
      301: 'pending',
      302: 'pending',
      304: 'pending',
      400: 'pending',
      401: 'pending',
      404: 'pending',
      422: 'pending',
      500: 'pending',
    });
    // A redirect is never followed, even by a transport that records the location.
    expect(t.transport.sent).toHaveLength(statuses.length);
    await t.close();
  });

  it('records a transport error as an attempt without a status, and retries it', async () => {
    const t = await sendingApp({ retry: noJitter });
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    t.transport.respondWith(() => {
      throw Object.assign(new Error('getaddrinfo failed'), { code: 'EAI_AGAIN' });
    });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));

    expect(await t.flush()).toMatchObject({ retried: 1 });
    const [delivery] = await t.deliveries.list({ endpointId: endpoint.id });
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: null, lastError: 'Error: getaddrinfo failed (EAI_AGAIN)' });
    expect((await t.deliveries.get(delivery!.id))!.history[0]).toMatchObject({ statusCode: null, response: null, error: 'Error: getaddrinfo failed (EAI_AGAIN)' });
    expect(t.events.find((e) => e.type === 'retry-scheduled')).toMatchObject({ statusCode: null, attempt: 1, delayMs: 1_000 });
    await t.close();
  });

  it('fails at once on NonRetryableWebhookError from a transport, without asking retryIf', async () => {
    class RefusingTransport extends WebhookTransport {
      async send(): Promise<never> {
        throw new NonRetryableWebhookError('the proxy refused this host');
      }
    }
    const retryIf = vi.fn(() => true);
    const t = await sendingApp({ transport: new RefusingTransport(), retry: { ...noJitter, retryIf } });
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));

    expect(await t.flush()).toMatchObject({ failed: 1 });
    const [delivery] = await t.deliveries.list({});
    expect(delivery).toMatchObject({ status: 'failed', failureReason: 'rejected', attempts: 1, lastError: 'NonRetryableWebhookError: the proxy refused this host' });
    expect(retryIf).not.toHaveBeenCalled();
    await t.close();
  });

  it('never asks retryIf about 410 Gone', async () => {
    const retryIf = vi.fn(() => true);
    const t = await sendingApp({ retry: { ...noJitter, retryIf } });
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    t.transport.respondWith(410);
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();
    expect(retryIf).not.toHaveBeenCalled();
    await t.close();
  });
});

describe('retry options', () => {
  it('passes retryIf the error, the attempt number and the delivery', async () => {
    const clock = controllableClock();
    const seen: [unknown, number, WebhookDelivery][] = [];
    const t = await sendingApp({
      retry: {
        ...noJitter,
        retryIf: (error, attempt, delivery) => {
          seen.push([error, attempt, delivery]);
          return true;
        },
      },
    });
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    t.transport.respondWith({ statusCode: 500, headers: { 'retry-after': '2' } });
    const message = await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();
    clock.advance(5_000);
    await t.worker.runOnce();

    expect(seen.map(([, attempt]) => attempt)).toEqual([1, 2]);
    const [error, , delivery] = seen[0]!;
    expect(error).toBeInstanceOf(WebhookResponseError);
    expect(error).toMatchObject({ statusCode: 500, retryAfterMs: 2_000 });
    expect(delivery).toMatchObject({ endpointId: endpoint.id, messageId: message.id, attempts: 0 });
    await t.close();
  });

  it('retries when retryIf throws, and logs it', async () => {
    const logger = new CapturingLogger();
    const t = await sendingApp(
      {
        retry: {
          ...noJitter,
          retryIf: () => {
            throw new Error('predicate bug');
          },
        },
      },
      { logger },
    );
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    t.transport.respondWith(500);
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));

    expect(await t.flush()).toMatchObject({ retried: 1 });
    expect(logger.lines.some((line) => line.includes('retry.retryIf threw, retrying: Error: predicate bug'))).toBe(true);
    await t.close();
  });

  it('waits what a backoff function returns, as milliseconds or a duration string', async () => {
    const calls: [number, unknown][] = [];
    const clock = controllableClock();
    const t = await sendingApp({
      retry: {
        attempts: 3,
        backoff: (attempt, error) => {
          calls.push([attempt, error]);
          return attempt === 1 ? 1_500 : '2m';
        },
      },
    });
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    t.transport.respondWith(503);
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();
    clock.advance(10_000);
    await t.worker.runOnce();

    const delays = t.events.flatMap((e) => (e.type === 'retry-scheduled' ? [e.delayMs] : []));
    // A 503 without Retry-After pauses the endpoint, but the retry itself follows the function.
    expect(delays).toEqual([1_500, 120_000]);
    expect(calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    expect(calls[0]![1]).toMatchObject({ statusCode: 503 });
    await t.close();
  });

  it('falls back to the default schedule when the backoff function throws', async () => {
    const logger = new CapturingLogger();
    const t = await sendingApp(
      {
        retry: {
          attempts: 3,
          backoff: () => {
            throw new Error('backoff bug');
          },
        },
      },
      { logger },
    );
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    t.transport.respondWith(500);
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();

    const event = t.events.find((e) => e.type === 'retry-scheduled');
    // The default's first wait: 5s with equal jitter.
    expect(event).toMatchObject({ type: 'retry-scheduled' });
    const { delayMs } = event as { delayMs: number };
    expect(delayMs).toBeGreaterThanOrEqual(2_500);
    expect(delayMs).toBeLessThanOrEqual(5_000);
    expect(logger.lines.some((line) => line.includes('retry.backoff failed, using the default: Error: backoff bug'))).toBe(true);
    await t.close();
  });

  it('takes a number as the attempt count, and false as a single attempt', async () => {
    const clock = controllableClock();
    const five = await sendingApp({ retry: 5 });
    await five.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    five.transport.respondWith(500);
    await five.transaction((tx) => five.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await five.flush();
    for (let i = 0; i < 6; i++) {
      clock.advance(86_400_000);
      await five.worker.runOnce();
    }
    expect(five.transport.sent).toHaveLength(5);
    expect((await five.deliveries.list({}))[0]).toMatchObject({ status: 'failed', failureReason: 'exhausted', attempts: 5 });
    await five.close();

    const once = await sendingApp({ retry: false });
    await once.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    once.transport.respondWith(500);
    await once.transaction((tx) => once.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    expect(await once.flush()).toMatchObject({ failed: 1, retried: 0 });
    expect((await once.deliveries.list({}))[0]).toMatchObject({ status: 'failed', failureReason: 'exhausted', attempts: 1 });
    await once.close();
  });

  it('waits for a Retry-After longer than the backoff, in seconds or as an HTTP date', async () => {
    const t = await sendingApp({ retry: noJitter });
    const seconds = await t.endpoints.create({ url: 'https://seconds.example/', eventTypes: ['*'] });
    const date = await t.endpoints.create({ url: 'https://date.example/', eventTypes: ['*'] });
    const garbage = await t.endpoints.create({ url: 'https://garbage.example/', eventTypes: ['*'] });
    const at = new Date(Date.now() + 120_000).toUTCString();
    t.transport.respondWith((request) => {
      const retryAfter = request.url.includes('seconds') ? ' 30 ' : request.url.includes('date') ? at : 'soon, maybe';
      return { statusCode: 500, headers: { 'retry-after': retryAfter } };
    });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();

    const delay = (endpointId: string) =>
      t.events.flatMap((e) => (e.type === 'retry-scheduled' && e.delivery.endpointId === endpointId ? [e.delayMs] : []))[0]!;
    expect(delay(seconds.id)).toBe(30_000);
    // HTTP dates have a one-second resolution.
    expect(delay(date.id)).toBeGreaterThan(118_000);
    expect(delay(date.id)).toBeLessThanOrEqual(120_000);
    expect(delay(garbage.id)).toBe(1_000);
    await t.close();
  });
});

describe('pausing an endpoint that asks for a breather', () => {
  it.each([502, 503, 504])('pauses for 5s after a %i without Retry-After, capped by backoff.maxDelay', async (status) => {
    const run = async (retry: WebhookRetryOptions) => {
      const t = await sendingApp({ retry });
      const endpoint = await t.endpoints.create({ url: 'https://busy.example/', eventTypes: ['*'] });
      t.transport.respondWith(status);
      await t.transaction((tx) => t.webhooks.dispatch(tx, [{ type: 'a.b', data: 1 }, { type: 'a.b', data: 2 }]));
      const before = Date.now();
      expect(await t.flush()).toMatchObject({ claimed: 2, retried: 1, released: 1 });
      const held = (await t.deliveries.list({ endpointId: endpoint.id })).find((d) => d.attempts === 0)!;
      await t.close();
      return held.nextAttemptAt! - before;
    };

    const standard = await run({ attempts: 3, backoff: { delay: '100ms', jitter: 'none' } });
    expect(standard).toBeGreaterThanOrEqual(5_000);
    expect(standard).toBeLessThan(6_000);
    const capped = await run({ attempts: 3, backoff: { delay: '100ms', maxDelay: '2s', jitter: 'none' } });
    expect(capped).toBeGreaterThanOrEqual(2_000);
    expect(capped).toBeLessThan(3_000);
  });

  it('does not pause on other failures: the rest of the batch still goes out', async () => {
    const t = await sendingApp({ retry: noJitter });
    const endpoint = await t.endpoints.create({ url: 'https://flaky.example/', eventTypes: ['*'] });
    t.transport.respondWith(500);
    await t.transaction((tx) => t.webhooks.dispatch(tx, [{ type: 'a.b', data: 1 }, { type: 'a.b', data: 2 }, { type: 'a.b', data: 3 }]));
    expect(await t.flush()).toMatchObject({ claimed: 3, retried: 3, released: 0 });
    expect(t.transport.filter({ endpointId: endpoint.id })).toHaveLength(3);
    await t.close();
  });
});

describe('signing at send time', () => {
  it('sends the configured user agent', async () => {
    const t = await sendingApp({ delivery: { userAgent: 'CatStore-Webhooks/2.3' } });
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();
    expect(t.transport.single().headers['user-agent']).toBe('CatStore-Webhooks/2.3');
    await t.close();
  });

  it('refuses to send without a live secret, and getSecret() finds none', async () => {
    const store = new InMemoryWebhookStore();
    const t = await sendingApp({ retry: noJitter }, { override: useStore(store) });
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    const now = Date.now();
    // Every secret expired: what a store that dropped the new secret of a rotation leaves.
    store.addEndpointSecret(endpoint.id, { secret: endpoint.secret, createdAt: now - 10, expiresAt: now - 1 }, 0, now);
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));

    expect(await t.flush()).toMatchObject({ failed: 1 });
    expect(t.transport.sent).toEqual([]);
    expect((await t.deliveries.list({}))[0]).toMatchObject({
      status: 'failed',
      failureReason: 'rejected',
      lastError: `NonRetryableWebhookError: Endpoint ${endpoint.id} has no live signing secret`,
    });
    await expect(t.endpoints.getSecret(endpoint.id)).rejects.toThrow(WebhookEndpointNotFoundError);
    await t.close();
  });

  it('signs with every secret of successive rotations while their overlaps last', async () => {
    const t = await sendingApp({ secretRotationOverlap: '1h' });
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    const second = await t.endpoints.rotateSecret(endpoint.id);
    const third = await t.endpoints.rotateSecret(endpoint.id);
    expect(await t.endpoints.getSecret(endpoint.id)).toBe(third);
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.flush();

    const sent = t.transport.single();
    expect(sent.headers['webhook-signature']!.split(' ')).toHaveLength(3);
    for (const secret of [endpoint.secret, second, third]) {
      expect(sent.isSignedWith(secret)).toBe(true);
    }
    await t.close();
  });
});

describe('endpoint health', () => {
  it('never disables an endpoint with disableEndpointAfter: false', async () => {
    const clock = controllableClock();
    const t = await sendingApp({ disableEndpointAfter: false, retry: false });
    const endpoint = await t.endpoints.create({ url: 'https://down.example/', eventTypes: ['*'] });
    t.transport.respondWith(500);
    for (let day = 0; day < 3; day++) {
      await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
      await t.flush();
      clock.advance(30 * 86_400_000);
    }
    expect(await t.endpoints.get(endpoint.id)).toMatchObject({ enabled: true, failingSince: expect.any(Number) });
    expect(t.events.some((e) => e.type === 'endpoint-disabled')).toBe(false);
    await t.close();
  });

  it('publishes every outcome on its diagnostics channel, in the order it happened', async () => {
    const clock = controllableClock();
    const t = await sendingApp({ retry: noJitter });
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'], tenant: 'shop-1' });
    const seen: [string, unknown][] = [];
    const names = ['delivered', 'retry-scheduled', 'delivery-failed', 'endpoint-disabled'];
    const listeners = names.map((name) => {
      const listener = (event: unknown) => seen.push([name, event]);
      subscribe(`nestjs:webhooks:${name}`, listener);
      return () => unsubscribe(`nestjs:webhooks:${name}`, listener);
    });

    try {
      t.transport.respondWith((_request, attempt) => (attempt === 1 ? 500 : 200));
      await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', tenant: 'shop-1', data: 1 }));
      await t.flush();
      clock.advance(2_000);
      await t.worker.runOnce();
      t.transport.respondWith(410);
      await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', tenant: 'shop-1', data: 2 }));
      await t.flush();
    } finally {
      listeners.forEach((stop) => stop());
    }

    expect(seen.map(([name]) => name)).toEqual(['retry-scheduled', 'delivered', 'endpoint-disabled', 'delivery-failed']);
    expect(seen[2]![1]).toEqual({ type: 'endpoint-disabled', endpointId: endpoint.id, tenant: 'shop-1', reason: 'gone' });
    expect(seen[3]![1]).toMatchObject({ type: 'delivery-failed', reason: 'rejected', statusCode: 410, attempt: 1 });
    // The same events, in the same order, on events$.
    expect(t.events.map((e) => e.type)).toEqual(['retry-scheduled', 'delivered', 'endpoint-disabled', 'delivery-failed']);
    await t.close();
  });

  it('completes events$ when the application shuts down', async () => {
    const t = await sendingApp();
    const complete = vi.fn();
    t.app.get(WebhooksEvents).events$.subscribe({ complete });
    await t.close();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('batches, concurrency and leases', () => {
  it('claims at most batchSize deliveries per run', async () => {
    const t = await sendingApp({ worker: { batchSize: 2 } });
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await t.transaction((tx) => t.webhooks.dispatch(tx, Array.from({ length: 5 }, (_, n) => ({ type: 'a.b', data: n }))));
    await t.relay.runOnce();
    const runs = [await t.worker.runOnce(), await t.worker.runOnce(), await t.worker.runOnce(), await t.worker.runOnce()];
    expect(runs.map((r) => r.claimed)).toEqual([2, 2, 1, 0]);
    // One endpoint's deliveries go in the order they were dispatched.
    expect(t.transport.sent.map((s) => s.data)).toEqual([0, 1, 2, 3, 4]);
    await t.close();
  });

  it('delivers to at most `concurrency` endpoints at once, and to one endpoint one at a time', async () => {
    const t = await sendingApp({ worker: { concurrency: 2 } });
    for (const name of ['a', 'b', 'c', 'd']) {
      await t.endpoints.create({ url: `https://${name}.example/`, eventTypes: ['*'] });
    }
    let active = 0;
    let peak = 0;
    const perEndpoint = new Map<string, number>();
    let peakPerEndpoint = 0;
    t.transport.respondWith(async (request: WebhookRequest) => {
      active++;
      perEndpoint.set(request.endpointId, (perEndpoint.get(request.endpointId) ?? 0) + 1);
      peak = Math.max(peak, active);
      peakPerEndpoint = Math.max(peakPerEndpoint, perEndpoint.get(request.endpointId)!);
      await sleep(5);
      active--;
      perEndpoint.set(request.endpointId, perEndpoint.get(request.endpointId)! - 1);
      return 200;
    });
    await t.transaction((tx) => t.webhooks.dispatch(tx, [{ type: 'a.b', data: 1 }, { type: 'a.b', data: 2 }]));

    expect(await t.flush()).toMatchObject({ claimed: 8, delivered: 8 });
    expect(peak).toBe(2);
    expect(peakPerEndpoint).toBe(1);
    await t.close();
  });

  it('never starts an attempt that could outlive the lease: the rest of the group is released, due at once', async () => {
    const clock = controllableClock();
    const t = await sendingApp({ delivery: { timeout: '10s' }, worker: { lease: '11s' } });
    await t.endpoints.create({ url: 'https://slow.example/', eventTypes: ['*'] });
    t.transport.respondWith(() => {
      clock.advance(2_000);
      return 200;
    });
    await t.transaction((tx) => t.webhooks.dispatch(tx, [{ type: 'a.b', data: 1 }, { type: 'a.b', data: 2 }]));

    expect(await t.flush()).toMatchObject({ claimed: 2, delivered: 1, released: 1 });
    expect(await t.worker.runOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(t.transport.sent.map((s) => s.data)).toEqual([1, 2]);
    await t.close();
  });

  it('counts an attempt in flight, and leaves a leased delivery out of a manual retry', async () => {
    const t = await sendingApp();
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.transport.respondWith(async () => {
      await gate;
      return 200;
    });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.relay.runOnce();

    const run = t.worker.runOnce();
    await vi.waitFor(() => expect(t.transport.sent).toHaveLength(1));
    expect(await t.deliveries.stats()).toMatchObject({ inFlight: 1, leased: 1, pending: 1, due: 0 });
    expect(await t.deliveries.retry({ all: true })).toBe(0);

    release();
    expect(await run).toMatchObject({ delivered: 1 });
    expect(await t.deliveries.stats()).toMatchObject({ inFlight: 0, leased: 0, pending: 0 });
    await t.close();
  });

  it('on stop(), finishes the attempt in flight, releases the rest of the batch, and claims nothing more', async () => {
    const t = await sendingApp();
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.transport.respondWith(async () => {
      await gate;
      return 200;
    });
    await t.transaction((tx) => t.webhooks.dispatch(tx, [{ type: 'a.b', data: 1 }, { type: 'a.b', data: 2 }, { type: 'a.b', data: 3 }]));
    await t.relay.runOnce();

    const run = t.worker.runOnce();
    await vi.waitFor(() => expect(t.transport.sent).toHaveLength(1));
    const stopped = t.worker.stop();
    release();
    await stopped;

    expect(await run).toMatchObject({ claimed: 3, delivered: 1, released: 2 });
    expect(t.transport.sent).toHaveLength(1);
    expect(await t.deliveries.stats()).toMatchObject({ pending: 2, due: 2, leased: 0 });
    expect(await t.worker.runOnce()).toMatchObject({ claimed: 0 });
    await t.close();
  });

  it('runs only when enabled, and notify() does nothing while stopped', async () => {
    const t = await sendingApp();
    expect(t.worker.running).toBe(false);
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.relay.runOnce();
    t.worker.notify();
    await sleep(20);
    expect(t.transport.sent).toEqual([]);

    t.worker.start();
    expect(t.worker.running).toBe(true);
    await vi.waitFor(() => expect(t.transport.sent).toHaveLength(1));
    await t.close();
    expect(t.worker.running).toBe(false);
  });
});

describe('a store that misbehaves', () => {
  it('counts an attempt whose lease was taken over as lost, without an event', async () => {
    class TakenOver extends InMemoryWebhookStore {
      override recordDeliveryAttempt(): boolean {
        return false;
      }
    }
    const logger = new CapturingLogger();
    const t = await sendingApp({}, { override: useStore(new TakenOver()), logger });
    await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));

    expect(await t.flush()).toMatchObject({ claimed: 1, delivered: 0, leaseLost: 1 });
    expect(t.events).toEqual([]);
    expect(logger.lines.some((line) => /Lease on webhook delivery dlv_\w+ was taken over/.test(line))).toBe(true);
    await t.close();
  });

  it('survives a store that throws: claiming, recording, or reading the endpoint', async () => {
    const failing = new Set<string>();
    class Flaky extends InMemoryWebhookStore {
      override claimDeliveries(request: WebhookClaimRequest) {
        if (failing.has('claim')) {
          throw new Error('connection reset');
        }
        return super.claimDeliveries(request);
      }
      override recordDeliveryAttempt(id: string, owner: string, update: WebhookDeliveryUpdate) {
        if (failing.has('record')) {
          throw new Error('deadlock');
        }
        return super.recordDeliveryAttempt(id, owner, update);
      }
      override recordEndpointFailure(...args: Parameters<InMemoryWebhookStore['recordEndpointFailure']>) {
        if (failing.has('failure')) {
          throw new Error('timeout');
        }
        return super.recordEndpointFailure(...args);
      }
      override getEndpoint(id: string) {
        if (failing.has('endpoint')) {
          throw new Error('endpoints table missing');
        }
        return super.getEndpoint(id);
      }
    }
    const clock = controllableClock();
    const logger = new CapturingLogger();
    const store = new Flaky();
    const t = await sendingApp({ retry: noJitter }, { override: useStore(store), logger });
    const endpoint = await t.endpoints.create({ url: 'https://a.example/', eventTypes: ['*'] });
    await t.transaction((tx) => t.webhooks.dispatch(tx, { type: 'a.b', data: {} }));
    await t.relay.runOnce();

    failing.add('claim');
    expect(await t.worker.runOnce()).toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0, released: 0, leaseLost: 0 });
    failing.clear();

    failing.add('record');
    expect(await t.worker.runOnce()).toMatchObject({ claimed: 1, delivered: 0, leaseLost: 1 });
    failing.clear();
    expect(await t.deliveries.stats()).toMatchObject({ leased: 1 }); // the lease expires on its own

    clock.advance(61_000);

    failing.add('endpoint');
    expect(await t.worker.runOnce()).toMatchObject({ claimed: 1, delivered: 0, retried: 0, failed: 0 });
    failing.clear();
    clock.advance(61_000);

    // An endpoint-health write that fails doesn't lose the attempt.
    failing.add('failure');
    t.transport.respondWith(500);
    expect(await t.worker.runOnce()).toMatchObject({ retried: 1 });
    expect((await t.deliveries.list({}))[0]).toMatchObject({ status: 'pending', lastStatusCode: 500 });
    expect((await t.endpoints.get(endpoint.id))!.failingSince).toBeNull();

    expect(logger.lines.filter((line) => line.includes('ERROR')).map((line) => line.replace(/^\[\w*\] ERROR /, ''))).toEqual([
      'Webhook store claimDeliveries failed: Error: connection reset',
      expect.stringMatching(/^Webhook store recordDeliveryAttempt failed for dlv_\w+: Error: deadlock$/),
      `Worker failed on endpoint ${endpoint.id}: Error: endpoints table missing`,
      'Webhook store recordEndpointFailure failed: Error: timeout',
    ]);
    await t.close();
  });
});
