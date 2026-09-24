/**
 * Registration: forRoot/forRootAsync, the transport at the top level (a class Nest
 * instantiates, with DI) or from the factory (an instance), and every option that fails at
 * startup with its name.
 */
import { Inject, Injectable, Module } from '@nestjs/common';
import { OutboxModule } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import {
  HttpWebhookTransport,
  InMemoryWebhookTransport,
  WEBHOOKS_MODULE_OPTIONS,
  WebhookEndpoints,
  WebhooksModule,
  WebhookTransport,
  Webhooks,
  type WebhooksModuleOptions,
  type WebhooksOptionsFactory,
  type WebhookRequest,
} from '../lib/index.js';

const CONFIG = 'CONFIG';
@Module({ providers: [{ provide: CONFIG, useValue: { url: 'https://proxy.internal' } }], exports: [CONFIG] })
class ConfigModule {}

async function compile(webhooks: ReturnType<typeof WebhooksModule.forRoot>, extra: any[] = []) {
  const moduleRef = await Test.createTestingModule({ imports: [OutboxModule.forRoot({ relay: { enabled: false } }), webhooks, ...extra] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('WebhooksModule registration', () => {
  it('builds the SSRF-guarded HTTP transport from the delivery options by default', async () => {
    const app = await compile(WebhooksModule.forRoot({ worker: { enabled: false } }));
    expect(app.get(WebhookTransport)).toBeInstanceOf(HttpWebhookTransport);
    expect(app.get(Webhooks)).toBeInstanceOf(Webhooks);
    await app.close();
  });

  it('instantiates a transport class from the top level, with DI from `imports`', async () => {
    @Injectable()
    class ProxyTransport extends WebhookTransport {
      constructor(@Inject(CONFIG) readonly config: { url: string }) {
        super();
      }
      async send(_request: WebhookRequest) {
        return { statusCode: 200, headers: {}, body: '' };
      }
    }
    const app = await compile(
      WebhooksModule.forRootAsync({
        imports: [ConfigModule],
        transport: ProxyTransport,
        useFactory: () => ({ worker: { enabled: false } }),
      }),
    );
    expect(app.get(WebhookTransport)).toBeInstanceOf(ProxyTransport);
    expect((app.get(WebhookTransport) as ProxyTransport).config.url).toBe('https://proxy.internal');
    await app.close();
  });

  it('takes a transport instance from the factory, and useClass options', async () => {
    const transport = new InMemoryWebhookTransport();
    const fromFactory = await compile(WebhooksModule.forRootAsync({ useFactory: () => ({ transport, worker: { enabled: false } }) }));
    expect(fromFactory.get(WebhookTransport)).toBe(transport);
    await fromFactory.close();

    @Injectable()
    class Options implements WebhooksOptionsFactory {
      createWebhooksOptions(): WebhooksModuleOptions {
        return { eventTypes: ['order.shipped'], worker: { enabled: false } };
      }
    }
    const withClass = await compile(WebhooksModule.forRootAsync({ useClass: Options }));
    expect(withClass.get(WEBHOOKS_MODULE_OPTIONS)).toEqual({ eventTypes: ['order.shipped'], worker: { enabled: false } });
    await expect(withClass.get(WebhookEndpoints).create({ url: 'https://a.example/', eventTypes: ['order.paid'] })).rejects.toThrow(/Unknown message type/);
    await withClass.close();
  });

  it('keeps structural options out of the options value', async () => {
    const transport = new InMemoryWebhookTransport();
    const app = await compile(WebhooksModule.forRoot({ transport, outgoing: true, isGlobal: true, worker: { enabled: false } }));
    expect(app.get(WEBHOOKS_MODULE_OPTIONS)).toEqual({ worker: { enabled: false } });
    await app.close();
  });

  it('provides only the receiving side with outgoing: false', async () => {
    const app = await compile(WebhooksModule.forRoot({ outgoing: false }));
    expect(() => app.get(Webhooks)).toThrow();
    await app.close();
    expect(() => WebhooksModule.forRoot({ outgoing: false, transport: new InMemoryWebhookTransport() })).toThrow(/`outgoing: false` sends none/);
  });

  it.each<[string, () => ReturnType<typeof WebhooksModule.forRoot>, RegExp]>([
    ['a class from the factory', () => WebhooksModule.forRootAsync({ useFactory: () => ({ transport: InMemoryWebhookTransport as never }) }), /returned a class as `transport`/],
    ['a transport set twice', () => WebhooksModule.forRootAsync({ transport: new InMemoryWebhookTransport(), useFactory: () => ({ transport: new InMemoryWebhookTransport() }) }), /set both at the top level/],
    ['a store as an option', () => WebhooksModule.forRoot({ store: {} } as never), /stores are not options/],
    ['a lease shorter than the timeout', () => WebhooksModule.forRoot({ delivery: { timeout: '30s' }, worker: { lease: '20s' } }), /worker.lease must be longer than delivery.timeout/],
    ['a bad duration', () => WebhooksModule.forRoot({ delivery: { timeout: 'soon' as never } }), /delivery.timeout: Invalid duration "soon"/],
    ['zero attempts', () => WebhooksModule.forRoot({ retry: { attempts: 0 } }), /retry.attempts must be a whole number of at least 1/],
    ['a bad jitter', () => WebhooksModule.forRoot({ retry: { backoff: { jitter: 'some' as never } } }), /retry.backoff.jitter/],
    ['a bad event type', () => WebhooksModule.forRoot({ eventTypes: ['order shipped'] }), /eventTypes: "order shipped" is not a message type/],
    ['a short encryption key', () => WebhooksModule.forRoot({ encryption: { keys: ['password'] } }), /encryption.keys\[0\]` must be 32 random bytes/],
    ['a malformed allowed range', () => WebhooksModule.forRoot({ delivery: { allowedAddresses: ['10.0.0.0/40'] } }), /delivery.allowedAddresses\[0\]/],
    ['a negative response size', () => WebhooksModule.forRoot({ delivery: { maxResponseSize: -1 } }), /delivery.maxResponseSize/],
    ['a zero batch', () => WebhooksModule.forRoot({ worker: { batchSize: 0 } }), /worker.batchSize must be a whole number/],
  ])('fails at startup on %s, naming the option', async (_name, module, message) => {
    await expect(Promise.resolve().then(() => compile(module()))).rejects.toThrow(message);
  });
});
