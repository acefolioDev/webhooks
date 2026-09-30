/**
 * WebhooksStorage: how an application's stores get registered (`endpoints`, `deliveries`),
 * every rule that keeps a registration from going wrong silently, and the contract suites
 * against the in-memory store.
 */
import { Injectable, Module, Scope, type OnModuleInit } from '@nestjs/common';
import { OutboxModule } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import {
  InMemoryWebhookStore,
  WebhookEndpoints,
  WebhooksModule,
  WebhooksStorage,
  type WebhookEndpointRecord,
  type WebhookEndpointSecret,
  type WebhookEndpointStore,
} from '../lib/index.js';
import { LOCK_STORAGE } from '../lib/webhooks.constants.js';
import { webhookDeliveryStoreContract, webhookEndpointStoreContract } from '../lib/testing/index.js';
import { CapturingLogger } from './helpers.js';

@Injectable()
class AppWebhookStore extends InMemoryWebhookStore {
  constructor(storage: WebhooksStorage) {
    super();
    storage.registerSource({ endpoints: this, deliveries: this });
  }
}

@Injectable()
class OtherWebhookStore extends InMemoryWebhookStore {
  constructor(storage: WebhooksStorage) {
    super();
    storage.registerSource({ endpoints: this, deliveries: this });
  }
}

async function boot(providers: any[], options: { outgoing?: boolean; allowInMemoryStorage?: boolean } = {}, logger = new CapturingLogger()) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      OutboxModule.forRoot({ relay: { enabled: false }, allowInMemoryStorage: true }),
      WebhooksModule.forRoot({ worker: { enabled: false }, outgoing: options.outgoing, allowInMemoryStorage: options.allowInMemoryStorage }),
    ],
    providers,
  }).compile();
  const app = moduleRef.createNestApplication({ logger });
  await app.init();
  return { app, logger };
}

describe('WebhooksStorage', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('uses the registered store, and logs it', async () => {
    const { app, logger } = await boot([AppWebhookStore]);
    const storage = app.get(WebhooksStorage);
    expect(storage.endpoints).toBe(app.get(AppWebhookStore));
    expect(storage.deliveries).toBe(app.get(AppWebhookStore));
    expect(logger.lines).toContain('[WebhooksModule] WebhooksStorage: AppWebhookStore');
    await app.get(WebhookEndpoints).create({ url: 'https://a.example/', eventTypes: ['*'] });
    expect(app.get(AppWebhookStore).listEndpoints({})).toHaveLength(1);
    await app.close();
  });

  it('runs in memory without a store, and says so', async () => {
    const { app, logger } = await boot([]);
    expect(app.get(WebhooksStorage).endpoints).toBeInstanceOf(InMemoryWebhookStore);
    expect(logger.lines.some((line) => line.includes('WebhooksStorage: InMemoryWebhookStore (the default'))).toBe(true);
    await app.close();
  });

  it('checks the shape at once, naming the missing methods', () => {
    const storage = new WebhooksStorage();
    const partial = { createEndpoint() {}, getEndpoint() {} };
    expect(() => storage.registerSource({ endpoints: partial as never })).toThrow(
      /Object|an object doesn't implement WebhookEndpointStore for `endpoints`: listEndpoints\(\), findSubscribedEndpoints\(\), updateEndpoint\(\), deleteEndpoint\(\), addEndpointSecret\(\), recordEndpointFailure\(\), recordEndpointSuccess\(\) are missing/,
    );
    const store = new InMemoryWebhookStore();
    expect(() => storage.registerSource(store as never)).toThrow(
      'the contracts go by name, and InMemoryWebhookStore was passed as itself. Name what it implements: `registerSource({ endpoints: this, deliveries: this })`',
    );
    expect(() => storage.registerSource({ inbox: store } as never)).toThrow(/unknown contract `inbox`/);
    expect(() => storage.registerSource({})).toThrow(/got none/);
    expect(() => storage.registerSource({ endpoints: InMemoryWebhookStore as never })).toThrow(/the class InMemoryWebhookStore \(pass an instance\)/);
    // Nothing was registered by the refused calls.
    storage.registerSource({ endpoints: store });
  });

  it('refuses a second registration, naming both classes, unless it replaces on purpose', async () => {
    await expect(boot([AppWebhookStore, OtherWebhookStore])).rejects.toThrow(
      "OtherWebhookStore can't register `endpoints`, AppWebhookStore already did",
    );
    const storage = new WebhooksStorage();
    const a = new InMemoryWebhookStore();
    storage.registerSource({ endpoints: a });
    expect(() => storage.registerSource({ endpoints: a })).toThrow(/the same instance, twice/);
    const b = new InMemoryWebhookStore();
    storage.registerSource({ endpoints: b }, { replace: true });
    expect(storage.endpoints).toBe(b);
  });

  it('takes each contract from its own provider', async () => {
    @Injectable()
    class Endpoints extends InMemoryWebhookStore {
      constructor(storage: WebhooksStorage) {
        super();
        storage.registerSource({ endpoints: this });
      }
    }
    const { app, logger } = await boot([Endpoints]);
    expect(app.get(WebhooksStorage).endpoints).toBe(app.get(Endpoints));
    expect(app.get(WebhooksStorage).deliveries).not.toBe(app.get(Endpoints));
    expect(logger.lines).toContain('[WebhooksModule] WebhooksStorage: Endpoints (endpoints); in-memory (deliveries)');
    await app.close();
  });

  it('locks at init: a late registration throws', async () => {
    @Injectable()
    class LateStore extends InMemoryWebhookStore implements OnModuleInit {
      constructor(private readonly storage: WebhooksStorage) {
        super();
      }
      onModuleInit() {
        this.storage.registerSource({ endpoints: this, deliveries: this });
      }
    }
    @Module({ providers: [LateStore] })
    class LateModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [OutboxModule.forRoot({ relay: { enabled: false } }), WebhooksModule.forRoot({ worker: { enabled: false } }), LateModule],
    }).compile();
    await expect(moduleRef.createNestApplication({ logger: false }).init()).rejects.toThrow(
      /LateStore \(endpoints, deliveries\) registered after WebhooksModule initialized.*constructor of a singleton provider/,
    );
  });

  it('locks at the first read, if another module reads in its own onModuleInit first', () => {
    const storage = new WebhooksStorage();
    expect(storage.endpoints).toBeInstanceOf(InMemoryWebhookStore);
    expect(() => storage.registerSource({ endpoints: new InMemoryWebhookStore() })).toThrow(/after WebhooksModule initialized \(or after its storage was first read\)/);
    storage[LOCK_STORAGE](); // idempotent
  });

  it('can not be registered by a request-scoped provider (it never constructs at startup)', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedStore extends InMemoryWebhookStore {
      constructor(storage: WebhooksStorage) {
        super();
        storage.registerSource({ endpoints: this, deliveries: this });
      }
    }
    const { app } = await boot([ScopedStore]);
    expect(app.get(WebhooksStorage).endpoints).toBeInstanceOf(InMemoryWebhookStore);
    expect(app.get(WebhooksStorage).endpoints).not.toBeInstanceOf(ScopedStore);
    await app.close();
  });

  it('refuses to start in production in memory, naming the first-party stores, the interfaces and the call', async () => {
    process.env.NODE_ENV = 'production';
    await expect(boot([])).rejects.toThrow(
      'WebhooksStorage: no store is registered for `endpoints` (WebhookEndpointStore) and `deliveries` (WebhookDeliveryStore), and NODE_ENV is ' +
        '"production": in memory, endpoints and their secrets and pending deliveries and the delivery log would be lost on restart and not shared ' +
        'between instances. Register a store on your database: PostgresWebhookStore (@nestjs/webhooks/postgres), MySqlWebhookStore ' +
        '(@nestjs/webhooks/mysql), or your own WebhookEndpointStore and WebhookDeliveryStore in a provider that injects WebhooksStorage and calls ' +
        '`storage.registerSource({ endpoints: this, deliveries: this })` in its constructor. Or set `allowInMemoryStorage: true` in the ' +
        'WebhooksModule options to run in memory anyway.',
    );

    const allowed = await boot([], { allowInMemoryStorage: true });
    await allowed.app.close();
    const registered = await boot([AppWebhookStore]);
    await registered.app.close();
    // A service that only receives uses neither.
    const receiving = await boot([], { outgoing: false });
    expect(() => receiving.app.get(WebhooksStorage).endpoints).toThrow(/NODE_ENV is "production"/);
    await receiving.app.close();
  });

  it('tests swap the store with overrideProvider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OutboxModule.forRoot({ relay: { enabled: false } }), WebhooksModule.forRoot({ worker: { enabled: false } })],
      providers: [AppWebhookStore],
    })
      .overrideProvider(AppWebhookStore)
      .useValue(new InMemoryWebhookStore())
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    expect(app.get(WebhooksStorage).endpoints).toBeInstanceOf(InMemoryWebhookStore);
    await app.close();
  });
});

describe('InMemoryWebhookStore against the contracts', () => {
  const harness = () => ({ store: new InMemoryWebhookStore() });
  describe('WebhookEndpointStore', () => {
    for (const c of webhookEndpointStoreContract(harness, { concurrent: true })) {
      it(c.name, c.run);
    }
  });
  describe('WebhookDeliveryStore', () => {
    for (const c of webhookDeliveryStoreContract(harness, { concurrent: true })) {
      it(c.name, c.run);
    }
  });

  it('catches a store whose fan-out query leaks another tenant', async () => {
    class LeakyStore extends InMemoryWebhookStore implements WebhookEndpointStore {
      override findSubscribedEndpoints(_tenant: string | null, type: string) {
        return this.listEndpoints({ limit: 1_000 }).filter((e) => e.enabled && (e.eventTypes.includes(type) || e.eventTypes.includes('*')));
      }
    }
    const [leak] = webhookEndpointStoreContract(() => ({ store: new LeakyStore() })).filter((c) => c.name.startsWith('finds the enabled'));
    await expect(leak!.run()).rejects.toThrow();
  });

  it('catches a store that loses a rotation', async () => {
    // Reads the endpoint, waits, then writes its secrets back: another rotation lands in between.
    const losing = () => {
      const store = new InMemoryWebhookStore();
      const rows = (store as unknown as { endpointRows: Map<string, WebhookEndpointRecord> }).endpointRows;
      return Object.assign(store, {
        async addEndpointSecret(id: string, secret: WebhookEndpointSecret, expireOthersAt: number) {
          const before = store.getEndpoint(id)!;
          await new Promise((resolve) => setTimeout(resolve, 5));
          rows.set(id, { ...before, secrets: [secret, ...before.secrets.map((s) => ({ ...s, expiresAt: expireOthersAt }))] });
          return true;
        },
      });
    };
    const [race] = webhookEndpointStoreContract(() => ({ store: losing() }), { concurrent: true }).filter((c) =>
      c.name.startsWith('rotations at once'),
    );
    await expect(race!.run()).rejects.toThrow(/a rotation was lost/);
  });
});
