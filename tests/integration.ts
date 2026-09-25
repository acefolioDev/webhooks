/**
 * Two real applications for the integration specs, each on Express or Fastify and listening
 * on 127.0.0.1:
 *
 * - a sender, the cat store: the partner API recipe (endpoints and the delivery log behind
 *   `/partners/:tenant/...`, the package's errors answered with their status), and an orders
 *   route that dispatches inside the application's transaction. The relay and the worker run
 *   by hand (`flush()`) unless a test turns them on.
 * - a receiver, a partner: `@VerifyWebhook()` routes for every scheme the docs page lists, whose
 *   answers a test scripts (a status, `Retry-After`, a redirect, a hang, a handler that throws).
 */
import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  type ArgumentsHost,
  type INestApplication,
  type LoggerService,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, BaseExceptionFilter } from '@nestjs/core';
import { InMemoryOutboxStore, OutboxModule, OutboxRelay, OutboxStorage } from '@nestjs/outbox';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { AddressInfo } from 'node:net';
import { adapters, createApp, type AdapterName } from './support/adapters.js';
import {
  HttpWebhookTransport,
  IncomingWebhook,
  VerifyWebhook,
  WebhookDeliveries,
  WebhookEndpoints,
  Webhooks,
  WebhooksError,
  WebhooksEvents,
  WebhookSignatureScheme,
  WebhooksModule,
  WebhookTransport,
  WebhookWorker,
  type WebhookReceiverOptions,
  type WebhookRequest,
  type WebhooksEvent,
  type WebhookSignatureCheck,
  type WebhookSignedRequest,
  type WebhookTransportResponse,
  type WebhookTransportSendOptions,
} from '../lib/index.js';
import type { WebhooksModuleRootOptions } from '../lib/interfaces/webhooks-module-options.interface.js';
import { CapturingLogger } from './helpers.js';

export const STANDARD_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
export const NEXT_SECRET = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;

// ------------------------------------------------------------------ the receiver

/** Shopify's scheme, as an app adds one: base64 HMAC-SHA256 of the body, the id in its own header. */
export class ShopifyScheme extends WebhookSignatureScheme {
  verify({ headers, rawBody }: WebhookSignedRequest, keys: readonly Buffer[]): WebhookSignatureCheck {
    const signature = headers['x-shopify-hmac-sha256'];
    if (typeof signature !== 'string') {
      return { valid: false, reason: 'missing-header', detail: 'no x-shopify-hmac-sha256' };
    }

    const candidates = [Buffer.from(signature, 'base64')];
    for (const key of keys) {
      if (WebhookSignatureScheme.matches(createHmac('sha256', key).update(rawBody).digest(), candidates)) {
        return { valid: true, id: headers['x-shopify-webhook-id'] as string };
      }
    }
    return { valid: false, reason: 'invalid-signature', detail: 'no signature matches' };
  }
}

export interface Hit {
  route: string;
  id: string;
  timestamp: Date | null;
  payload: any;
  headers: Record<string, string | string[] | undefined>;
}

/** What a scripted route answers: a 2xx body, or an error status (with headers, such as `Retry-After`). */
export interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  hang?: boolean;
  fail?: boolean;
}

/** The partner's side of the story: every request its handlers ran for, and how to answer the next ones. */
@Injectable()
export class Partner {
  readonly hits: Hit[] = [];
  answer: (hit: Hit) => Answer | undefined = () => undefined;
  private readonly hanging = new Set<() => void>();

  of(route: string): Hit[] {
    return this.hits.filter((hit) => hit.route === route);
  }

  /** Lets every hanging handler finish, so the application can close. */
  release() {
    for (const resolve of this.hanging) {
      resolve();
    }
    this.hanging.clear();
  }

  async handle(route: string, webhook: IncomingWebhook, headers: Hit['headers'], res: { header(name: string, value: string): unknown }) {
    const hit: Hit = { route, id: webhook.id, timestamp: webhook.timestamp, payload: webhook.payload, headers };
    this.hits.push(hit);
    const answer = this.answer(hit) ?? {};

    if (answer.hang) {
      await new Promise<void>((resolve) => this.hanging.add(resolve));
    }

    if (answer.fail) {
      throw new Error('the partner database is down');
    }

    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      res.header(name, value);
    }
    if (answer.status !== undefined && answer.status >= 300) {
      // An exception, not a response: the inbox records the id only for a handler that succeeded.
      throw new HttpException(answer.body ?? `scripted ${answer.status}`, answer.status);
    }
    return answer.body;
  }
}

@Controller('hooks')
class PartnerController {
  constructor(private readonly partner: Partner) {}

  @Post('standard')
  @HttpCode(200)
  @VerifyWebhook('standard')
  standard(@IncomingWebhook() webhook: IncomingWebhook, @Headers() headers: Hit['headers'], @Res({ passthrough: true }) res: never) {
    return this.partner.handle('standard', webhook, headers, res);
  }

  @Post('stripe')
  @HttpCode(200)
  @VerifyWebhook('stripe')
  stripe(@IncomingWebhook() webhook: IncomingWebhook, @Headers() headers: Hit['headers'], @Res({ passthrough: true }) res: never) {
    return this.partner.handle('stripe', webhook, headers, res);
  }

  @Post('github')
  @HttpCode(200)
  @VerifyWebhook('github')
  github(@IncomingWebhook() webhook: IncomingWebhook, @Headers() headers: Hit['headers'], @Res({ passthrough: true }) res: never) {
    return this.partner.handle('github', webhook, headers, res);
  }

  @Post('shopify')
  @HttpCode(200)
  @VerifyWebhook('shopify')
  shopify(@IncomingWebhook() webhook: IncomingWebhook, @Headers() headers: Hit['headers'], @Res({ passthrough: true }) res: never) {
    return this.partner.handle('shopify', webhook, headers, res);
  }

  /** Every copy runs the handler: counts what arrives on the wire. */
  @Post('counted')
  @HttpCode(200)
  @VerifyWebhook('counted')
  counted(@IncomingWebhook() webhook: IncomingWebhook, @Headers() headers: Hit['headers'], @Res({ passthrough: true }) res: never) {
    return this.partner.handle('counted', webhook, headers, res);
  }
}

/** The receivers the partner configures, with the secret the store gave it (every scheme keyed with the same text). */
export function partnerReceivers(secrets: readonly string[] = [STANDARD_SECRET], tolerance?: string): Record<string, WebhookReceiverOptions> {
  return {
    standard: { scheme: 'standard', secret: secrets, ...(tolerance ? { tolerance: tolerance as never } : {}) },
    stripe: { scheme: 'stripe', secret: secrets, header: 'Store-Signature' },
    github: { scheme: 'github', secret: secrets },
    shopify: { scheme: new ShopifyScheme(), secret: secrets },
    counted: { scheme: 'standard', secret: secrets, dedupe: false },
  };
}

export interface ReceiverSetup {
  receivers?: Record<string, WebhookReceiverOptions>;
  controllers?: Type[];
  providers?: Provider[];
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  logger?: LoggerService;
}

/** The partner's receive-only service (`outgoing: false`), created with `rawBody: true` as its main.ts would. */
export async function startReceiver(adapter: AdapterName, setup: ReceiverSetup = {}) {
  @Module({
    imports: [
      OutboxModule.forRoot({ relay: { enabled: false } }),
      WebhooksModule.forRoot({ outgoing: false, receivers: setup.receivers ?? partnerReceivers() }),
    ],
    controllers: [PartnerController, ...(setup.controllers ?? [])],
    providers: [Partner, ...(setup.providers ?? [])],
  })
  class ReceiverModule {}

  let builder = Test.createTestingModule({ imports: [ReceiverModule] });
  if (setup.override) {
    builder = setup.override(builder);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication(adapters.find((a) => a.name === adapter)!.create() as never, {
    rawBody: true,
    logger: setup.logger ?? false,
  });
  await app.listen(0, '127.0.0.1');

  const events: WebhooksEvent[] = [];
  app.get(WebhooksEvents).events$.subscribe((event) => events.push(event));
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const partner = app.get(Partner);

  return {
    app,
    port,
    partner,
    events,
    url: (path = 'standard', host = '127.0.0.1') => `http://${host}:${port}/hooks/${path}`,
    async close() {
      partner.release();
      await app.close();
    },
  };
}

export type Receiver = Awaited<ReturnType<typeof startReceiver>>;

/** Answers in turn, then the last one for every later request. */
export function inTurn(...answers: Answer[]): (hit: Hit) => Answer {
  let call = 0;
  return () => answers[Math.min(call++, answers.length - 1)]!;
}

// ------------------------------------------------------------------ the sender

/** Runs `work` in the application's transaction: commits when it resolves, rolls back when it throws. */
export abstract class Transactions {
  abstract run<T>(work: (tx: any) => Promise<T>): Promise<T>;
  abstract shipped(): Promise<string[]>;
  abstract recordShipment(tx: any, orderId: string): Promise<void>;
}

/** The in-memory outbox store's transactions, and a shipments "table" that commits with them. */
@Injectable()
export class InMemoryTransactions extends Transactions {
  private readonly shipments: string[] = [];
  private readonly pending = new WeakMap<object, string[]>();

  constructor(private readonly storage: OutboxStorage) {
    super();
  }

  async run<T>(work: (tx: any) => Promise<T>): Promise<T> {
    const writes: string[] = [];
    const result = await (this.storage.messages as InMemoryOutboxStore).transaction(async (tx) => {
      this.pending.set(tx as object, writes);
      return work(tx);
    });
    this.shipments.push(...writes);
    return result;
  }

  async shipped() {
    return [...this.shipments];
  }

  async recordShipment(tx: any, orderId: string) {
    this.pending.get(tx)!.push(orderId);
  }
}

/** The recipe the tutorial's partner API follows: the package's errors answered with their status. */
@Catch(WebhooksError)
class WebhooksErrorFilter extends BaseExceptionFilter {
  override catch(error: WebhooksError, host: ArgumentsHost) {
    const status = (error as { status?: number }).status;
    super.catch(status ? new HttpException({ message: error.message, field: (error as { field?: string }).field }, status, { cause: error }) : error, host);
  }
}

/** A partner's subscriptions and delivery log, scoped to the tenant in the path (the tutorial authenticates it). */
@Controller('partners/:tenant')
class PartnerApiController {
  constructor(
    private readonly webhookEndpoints: WebhookEndpoints,
    private readonly webhookDeliveries: WebhookDeliveries,
  ) {}

  @Post('webhook-endpoints')
  createEndpoint(@Param('tenant') tenant: string, @Body() dto: { url: string; eventTypes: string[]; secret?: string }) {
    return this.webhookEndpoints.create({ ...dto, tenant });
  }

  @Get('webhook-endpoints')
  listEndpoints(@Param('tenant') tenant: string) {
    return this.webhookEndpoints.list({ tenant });
  }

  @Patch('webhook-endpoints/:id')
  updateEndpoint(@Param('tenant') tenant: string, @Param('id') id: string, @Body() dto: { url?: string; enabled?: boolean }) {
    return this.webhookEndpoints.update(id, dto, { tenant });
  }

  @Delete('webhook-endpoints/:id')
  @HttpCode(204)
  async deleteEndpoint(@Param('tenant') tenant: string, @Param('id') id: string) {
    await this.webhookEndpoints.delete(id, { tenant });
  }

  @Post('webhook-endpoints/:id/rotate-secret')
  @HttpCode(200)
  async rotateSecret(@Param('tenant') tenant: string, @Param('id') id: string, @Body() dto: { overlap?: string; secret?: string }) {
    return { secret: await this.webhookEndpoints.rotateSecret(id, { tenant, ...dto } as never) };
  }

  @Get('webhook-deliveries')
  listDeliveries(@Param('tenant') tenant: string, @Query('status') status?: 'pending' | 'succeeded' | 'failed', @Query('endpointId') endpointId?: string) {
    return this.webhookDeliveries.list({ tenant, status, endpointId });
  }

  @Get('webhook-deliveries/:id')
  async getDelivery(@Param('tenant') tenant: string, @Param('id') id: string) {
    const delivery = await this.webhookDeliveries.get(id, { tenant });
    if (!delivery) {
      throw new NotFoundException(`Webhook delivery ${id} not found`);
    }
    return delivery;
  }

  @Post('webhook-deliveries/:id/retry')
  @HttpCode(200)
  async retryDelivery(@Param('tenant') tenant: string, @Param('id') id: string) {
    return { retried: await this.webhookDeliveries.retry(id, { tenant }) };
  }

  @Post('webhook-deliveries/retry')
  @HttpCode(200)
  async retryFailed(@Param('tenant') tenant: string, @Body() dto: { endpointId?: string }) {
    return { retried: await this.webhookDeliveries.retry({ endpointId: dto.endpointId, status: 'failed' }, { tenant }) };
  }
}

/** Ships an order: the shipment and its webhook commit together, or neither does. */
@Controller('orders')
class OrdersController {
  constructor(
    private readonly webhooks: Webhooks,
    @Inject(Transactions) private readonly transactions: Transactions,
  ) {}

  @Post(':id/ship')
  async ship(@Param('id') id: string, @Body() dto: { tenant?: string; type?: string; fail?: boolean }) {
    const message = await this.transactions.run(async (tx) => {
      await this.transactions.recordShipment(tx, id);
      const dispatched = await this.webhooks.dispatch(tx, {
        type: dto.type ?? 'order.shipped',
        tenant: dto.tenant ?? null,
        data: { orderId: id, carrier: 'standard-post' },
      });
      if (dto.fail) {
        throw new HttpException('the carrier refused the parcel', 409);
      }
      return dispatched;
    });
    this.webhooks.notify();
    return message;
  }
}

export interface SenderSetup {
  options?: WebhooksModuleRootOptions;
  /** `forRootAsync()` instead, for a transport instance built in the factory. */
  asyncOptions?: Parameters<typeof WebhooksModule.forRootAsync>[0];
  relay?: { enabled?: boolean; pollInterval?: string };
  providers?: Provider[];
  imports?: ModuleMetadata['imports'];
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  logger?: CapturingLogger;
}

/**
 * The store's API, booted with `createApp()` on the adapter. Development delivery settings (the
 * partner runs on this machine) and a short timeout, unless the test passes its own.
 */
export async function startSender(adapter: AdapterName, setup: SenderSetup = {}) {
  const webhooks =
    setup.asyncOptions !== undefined
      ? WebhooksModule.forRootAsync(setup.asyncOptions)
      : WebhooksModule.forRoot({
          worker: { enabled: false },
          delivery: { allowHttp: true, allowPrivateNetworks: true, timeout: '1s' },
          retry: { attempts: 3, backoff: { delay: '1s', factor: 2, maxDelay: '1m', jitter: 'none' } },
          ...setup.options,
        });

  @Module({
    imports: [OutboxModule.forRoot({ relay: { enabled: false, ...setup.relay } as never }), webhooks, ...(setup.imports ?? [])],
    controllers: [PartnerApiController, OrdersController],
    providers: [{ provide: APP_FILTER, useClass: WebhooksErrorFilter }, ...(setup.providers ?? [{ provide: Transactions, useClass: InMemoryTransactions }])],
  })
  class SenderModule {}

  const logger = setup.logger ?? new CapturingLogger();
  const app: INestApplication = await createApp(adapter, SenderModule, {
    override: setup.override,
    setup: (created) => created.useLogger(logger),
  });

  const events: WebhooksEvent[] = [];
  app.get(WebhooksEvents).events$.subscribe((event) => events.push(event));
  const relay = app.get(OutboxRelay);
  const worker = app.get(WebhookWorker);

  return {
    app,
    events,
    logger,
    relay,
    worker,
    endpoints: app.get(WebhookEndpoints),
    deliveries: app.get(WebhookDeliveries),
    transactions: app.get(Transactions) as Transactions,
    server: () => app.getHttpServer(),
    /** Publishes committed messages (the fan-out), then runs one worker batch. */
    async flush() {
      await relay.runOnce();
      return worker.runOnce();
    },
    close: () => app.close(),
  };
}

export type Sender = Awaited<ReturnType<typeof startSender>>;

// ------------------------------------------------------------------ transports and observation

/**
 * The answer to "a partner that wants a Stripe-style header": a custom transport that
 * re-signs. It keeps the package's delivery (the SSRF-guarded HTTP transport underneath) and
 * rewrites the signature for the scheme the endpoint's path names, with the endpoint's secret.
 */
@Injectable()
export class ResigningTransport extends WebhookTransport {
  private readonly http = new HttpWebhookTransport({ allowHttp: true, allowPrivateNetworks: true });
  /** Every request as it went on the wire, for a test that replays one. */
  readonly sent: WebhookRequest[] = [];

  constructor(private readonly webhookEndpoints: WebhookEndpoints) {
    super();
  }

  async send(request: WebhookRequest, options: WebhookTransportSendOptions): Promise<WebhookTransportResponse> {
    const scheme = new URL(request.url).pathname.split('/').pop();
    const outgoing = scheme === 'standard' || scheme === 'counted' ? request : await this.resign(request, scheme!);
    this.sent.push(outgoing);
    return this.http.send(outgoing, options);
  }

  private async resign(request: WebhookRequest, scheme: string): Promise<WebhookRequest> {
    const secret = await this.webhookEndpoints.getSecret(request.endpointId);
    const { 'webhook-id': _id, 'webhook-timestamp': timestamp, 'webhook-signature': _signature, ...headers } = request.headers;
    const hmac = (text: string) => createHmac('sha256', secret).update(text);

    if (scheme === 'stripe') {
      // Stripe's receivers deduplicate by the payload's `id`: it goes into the signed body.
      const body = `{"id":${JSON.stringify(request.messageId)},${request.body.slice(1)}`;
      return { ...request, body, headers: { ...headers, 'store-signature': `t=${timestamp},v1=${hmac(`${timestamp}.${body}`).digest('hex')}` } };
    }
    if (scheme === 'github') {
      return {
        ...request,
        headers: { ...headers, 'x-hub-signature-256': `sha256=${hmac(request.body).digest('hex')}`, 'x-github-delivery': request.messageId },
      };
    }
    return {
      ...request,
      headers: { ...headers, 'x-shopify-hmac-sha256': hmac(request.body).digest('base64'), 'x-shopify-webhook-id': request.messageId },
    };
  }
}

/** Every event published on the package's `node:diagnostics_channel` channels while it listens. */
export function listenToChannels() {
  const names = ['delivered', 'retry-scheduled', 'delivery-failed', 'endpoint-disabled', 'destination-blocked', 'verification-failed'];
  const published: { channel: string; event: WebhooksEvent }[] = [];
  const listeners = names.map((name) => {
    const channel = `nestjs:webhooks:${name}`;
    const listener = (event: unknown) => published.push({ channel, event: event as WebhooksEvent });
    subscribe(channel, listener);
    return () => unsubscribe(channel, listener);
  });

  return {
    published,
    types: () => published.map((entry) => entry.channel.slice('nestjs:webhooks:'.length)),
    close: () => listeners.forEach((stop) => stop()),
  };
}

/** Sends a captured request again, as someone who recorded it would. */
export function resend(request: Pick<WebhookRequest, 'url' | 'headers' | 'body'>, changes: { body?: string; headers?: Record<string, string> } = {}) {
  return fetch(request.url, { method: 'POST', headers: { ...request.headers, ...changes.headers }, body: changes.body ?? request.body });
}
