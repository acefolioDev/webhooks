import type { INestApplication, LoggerService } from '@nestjs/common';
import { InMemoryOutboxStore, OutboxModule, OutboxRelay, OutboxStorage } from '@nestjs/outbox';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { vi } from 'vitest';
import {
  InMemoryWebhookStore,
  InMemoryWebhookTransport,
  WebhookDeliveries,
  WebhookEndpoints,
  Webhooks,
  WebhooksEvents,
  WebhooksModule,
  WebhooksStorage,
  WebhookWorker,
  type WebhooksEvent,
} from '../lib/index.js';
import type { WebhooksModuleRootOptions } from '../lib/interfaces/webhooks-module-options.interface.js';

/** Collects log lines as `[Context] message`. */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  log(message: unknown, context?: string) {
    this.lines.push(`[${context}] ${message}`);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.lines.push(`[${rest.at(-1)}] ERROR ${message}`);
  }
  warn(message: unknown, context?: string) {
    this.lines.push(`[${context}] WARN ${message}`);
  }
  debug() {}
  verbose() {}
}

/**
 * Moves `Date.now()` forward without faking timers, so retry backoff, leases and secret
 * overlaps can be skipped while sockets keep running on real time.
 */
export function controllableClock() {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  return {
    advance(ms: number) {
      offset += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > timeout) {
      throw new Error('Timed out waiting');
    }
    await sleep(10);
  }
}

/**
 * An app sending webhooks through the in-memory outbox and stores, with the relay and the
 * worker driven by hand (`flush()`), and a transport that records requests.
 */
export async function sendingApp(
  options: WebhooksModuleRootOptions = {},
  setup: { override?: (builder: TestingModuleBuilder) => TestingModuleBuilder; providers?: any[]; logger?: LoggerService } = {},
) {
  // `transport: undefined` asks for the default HTTP transport.
  const transport = 'transport' in options ? undefined : new InMemoryWebhookTransport();
  let builder = Test.createTestingModule({
    imports: [
      OutboxModule.forRoot({ relay: { enabled: false } }),
      WebhooksModule.forRoot({ worker: { enabled: false }, ...options, ...(transport ? { transport } : {}) }),
    ],
    providers: setup.providers ?? [],
  });
  if (setup.override) {
    builder = setup.override(builder);
  }
  const moduleRef = await builder.compile();

  const app: INestApplication = moduleRef.createNestApplication({ logger: setup.logger ?? false });
  await app.init();

  const events: WebhooksEvent[] = [];
  app.get(WebhooksEvents).events$.subscribe((event) => events.push(event));
  const outboxStore = app.get(OutboxStorage).messages as InMemoryOutboxStore;
  const relay = app.get(OutboxRelay);
  const worker = app.get(WebhookWorker);

  return {
    app,
    transport: transport!,
    events,
    webhooks: app.get(Webhooks) as Webhooks<unknown>,
    endpoints: app.get(WebhookEndpoints),
    deliveries: app.get(WebhookDeliveries),
    worker,
    relay,
    /** Runs `work` in an in-memory outbox transaction: its messages apply when it resolves, and vanish when it throws. */
    transaction: <T>(work: (tx: unknown) => T | Promise<T>) => outboxStore.transaction(work),
    /** Publishes committed messages (the fan-out), then runs one worker batch. */
    async flush() {
      await relay.runOnce();
      return worker.runOnce();
    },
    close: () => app.close(),
  };
}

/** A `sendingApp()` override that makes the app use `store` for both contracts, so a test can reach into it or share it between apps. */
export function useStore(store: InMemoryWebhookStore) {
  return (builder: TestingModuleBuilder) =>
    builder.overrideProvider(WebhooksStorage).useFactory({
      factory: () => {
        const storage = new WebhooksStorage({ allowInMemoryStorage: true });
        storage.registerSource({ endpoints: store, deliveries: store });
        return storage;
      },
    });
}
