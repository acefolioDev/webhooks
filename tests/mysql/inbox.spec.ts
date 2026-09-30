/**
 * An incoming webhook's id against the outbox's inbox on MySQL (`MySqlOutboxStore`, whose inbox keeps consumer names and
 * message ids in 255-character columns), end to end on Express: the verifier refuses an id the inbox couldn't record
 * (over 255 characters, counted as MySQL counts them: an emoji is one) with a 401, at every delivery, before the handler
 * runs; an id of 255 is verified, handled once and recorded, whichever way the route records it: `@VerifyWebhook()`'s
 * deduplication (`OutboxInbox.process()`: the handler, then the record) or `processInTransaction()` (the record in the
 * handler's transaction), from a header (Standard Webhooks) or the payload (Stripe's scheme). A receiver's inbox
 * consumer name has the same bound, checked at startup.
 *
 * It needs @nestjs/outbox's MySQL store (`@nestjs/outbox/mysql`, which 0.0.1 doesn't have): without it, the tests skip
 * with the reason.
 */
import { Controller, HttpCode, Injectable, Module, Post, type DynamicModule, type INestApplication } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { IncomingWebhook, VerifyWebhook, WebhooksEvents, WebhooksModule, type WebhooksEvent } from '../../lib/index.js';
import { fromMysql2, type SqlExecutor } from '../../lib/mysql/index.js';
import { signWebhook } from '../../lib/testing/index.js';
import { onMysql, testDatabase } from './support.js';

/** What this test takes of `@nestjs/outbox/mysql`, loaded by a name TypeScript doesn't resolve: 0.0.1 has no such entry. */
interface OutboxMysqlEntry {
  MySqlOutboxStore: new (options: { executor: SqlExecutor }, storage?: OutboxStorage) => object;
}
const outboxMysqlEntry = '@nestjs/outbox/mysql';
const outboxMysql = (await import(outboxMysqlEntry).catch(() => null)) as OutboxMysqlEntry | null;

const { database, reason: noMysql } = await testDatabase('inbox');
const reason = noMysql ?? (outboxMysql ? undefined : 'the installed @nestjs/outbox has no MySQL store (@nestjs/outbox/mysql)');

const STANDARD_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const STRIPE_SECRET = 'stripe_test_5b0e1c';

@Injectable()
class Ledger {
  /** The ids of the webhooks the handlers ran for. */
  readonly handled: string[] = [];
  /** The application's pool, which the route that records in its own transaction takes a connection of. */
  pool!: mysql.Pool;
}

@Controller('webhooks')
class ReceiverController {
  constructor(private readonly ledger: Ledger) {}

  @Post('payments')
  @HttpCode(200)
  @VerifyWebhook('payments')
  payments(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.handled.push(webhook.id);
  }

  @Post('stripe')
  @HttpCode(200)
  @VerifyWebhook('stripe')
  stripe(@IncomingWebhook() webhook: IncomingWebhook) {
    this.ledger.handled.push(webhook.id);
  }

  /** The inbox record in the handler's own transaction, with its writes (the receiver doesn't deduplicate by itself). */
  @Post('payments-tx')
  @HttpCode(200)
  @VerifyWebhook('payments-tx')
  async paymentsInTransaction(@IncomingWebhook() webhook: IncomingWebhook) {
    const connection = await this.ledger.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await webhook.processInTransaction(connection, () => this.ledger.handled.push(webhook.id));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

/** The receiving application: its outbox's inbox on MySqlOutboxStore, registered as the docs show it. */
function receiver(pool: mysql.Pool, consumer?: string): DynamicModule {
  @Module({})
  class ReceiverModule {}

  return {
    module: ReceiverModule,
    imports: [
      OutboxModule.forRoot({ relay: { enabled: false } }),
      WebhooksModule.forRoot({
        outgoing: false,
        receivers: {
          payments: { scheme: 'standard', secret: STANDARD_SECRET, ...(consumer === undefined ? {} : { consumer }) },
          'payments-tx': { scheme: 'standard', secret: STANDARD_SECRET, dedupe: false },
          stripe: { scheme: 'stripe', secret: STRIPE_SECRET },
        },
      }),
    ],
    controllers: [ReceiverController],
    providers: [
      { provide: Ledger, useFactory: () => Object.assign(new Ledger(), { pool }) },
      {
        provide: outboxMysql!.MySqlOutboxStore,
        inject: [OutboxStorage],
        useFactory: (storage: OutboxStorage) => new outboxMysql!.MySqlOutboxStore({ executor: fromMysql2(pool) }, storage),
      },
    ],
  };
}

async function start(module: DynamicModule): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  const app = moduleRef.createNestApplication(new ExpressAdapter(), { rawBody: true, logger: false });
  await app.init();
  return app;
}

/** How many inbox records `consumer` has of `id`. */
async function recorded(consumer: string, id: string): Promise<number> {
  const [rows] = await database!.admin.query('SELECT COUNT(*) AS n FROM nest_outbox_inbox WHERE consumer = ? AND message_id = ?', [consumer, id]);
  return Number((rows as Array<{ n: number }>)[0]!.n);
}

describe("an incoming webhook's id and the outbox's inbox on MySQL", () => {
  onMysql(reason);
  let pool: mysql.Pool;
  let app: INestApplication;
  let ledger: Ledger;
  const events: WebhooksEvent[] = [];

  beforeAll(async () => {
    if (reason) {
      return;
    }
    pool = mysql.createPool({ uri: database!.url, connectionLimit: 3 });
    app = await start(receiver(pool));
    ledger = app.get(Ledger);
    app.get(WebhooksEvents).events$.subscribe((event) => events.push(event));
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const post = (path: string, signed: { body: string; headers: Record<string, string> }) => request(app.getHttpServer()).post(path).set(signed.headers).send(signed.body);
  const payment = (id: string) => signWebhook({ scheme: 'standard', secret: STANDARD_SECRET, payload: { type: 'payment.succeeded' }, id });

  it.each([
    ["@VerifyWebhook()'s deduplication (OutboxInbox.process())", 'payments'],
    ["processInTransaction(), in the handler's transaction", 'payments-tx'],
  ])('through %s: refuses an id of 256 characters with a 401 at every delivery, before the handler, and records one of 255 once', async (_how, route) => {
    const handled = ledger.handled.length;
    const seen = events.length;
    for (let delivery = 1; delivery <= 3; delivery++) {
      const response = await post(`/webhooks/${route}`, payment('i'.repeat(256))).expect(401);
      expect(response.body).toEqual({ message: 'Webhook signature verification failed', error: 'Unauthorized', statusCode: 401 });
    }
    expect(ledger.handled.length).toBe(handled);
    expect(events.slice(seen)).toEqual([1, 2, 3].map(() => ({ type: 'verification-failed', receiver: route, reason: 'malformed-header' })));

    const longest = 'i'.repeat(255);
    await post(`/webhooks/${route}`, payment(longest)).expect(200);
    await post(`/webhooks/${route}`, payment(longest)).expect(200);
    expect(ledger.handled.slice(handled)).toEqual([longest]);
    expect(await recorded(`webhooks:${route}`, longest)).toBe(1);
  });

  it("counts an id's characters as MySQL does, from a payload too: 255 emoji are recorded once, 256 refused", async () => {
    const charge = (id: string) => signWebhook({ scheme: 'stripe', secret: STRIPE_SECRET, payload: { id, type: 'charge.succeeded' } });
    await post('/webhooks/stripe', charge('😀'.repeat(256))).expect(401);
    const longest = '😀'.repeat(255);
    await post('/webhooks/stripe', charge(longest)).expect(200);
    await post('/webhooks/stripe', charge(longest)).expect(200);
    expect(ledger.handled.filter((id) => id === longest)).toHaveLength(1);
    expect(await recorded('webhooks:stripe', longest)).toBe(1);
  });
});

describe("a receiver's inbox consumer name and the outbox's inbox on MySQL", () => {
  onMysql(reason);

  it('records under the longest name the inbox keeps, and refuses a longer one at startup', async () => {
    const pool = mysql.createPool({ uri: database!.url, connectionLimit: 3 });
    try {
      const consumer = 'c'.repeat(255);
      const app = await start(receiver(pool, consumer));
      try {
        const signed = signWebhook({ scheme: 'standard', secret: STANDARD_SECRET, payload: {}, id: 'msg_consumer' });
        await request(app.getHttpServer()).post('/webhooks/payments').set(signed.headers).send(signed.body).expect(200);
        expect(await recorded(consumer, 'msg_consumer')).toBe(1);
      } finally {
        await app.close();
      }

      await expect((async () => start(receiver(pool, 'c'.repeat(256))))()).rejects.toThrow(
        "WebhooksModule: receivers.payments.consumer is longer than 255 characters: the outbox's inbox keeps consumer names in 255-character columns on MySQL.",
      );
    } finally {
      await pool.end();
    }
  });
});
