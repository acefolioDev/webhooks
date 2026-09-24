import { Inject, Module, Optional, type DynamicModule, type OnModuleInit, type Provider, type Type } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Outbox, OutboxInbox } from '@nestjs/outbox';
import { VERIFY_WEBHOOK_METADATA } from './webhooks.constants.js';
import { WebhookVerifier } from './services/webhook-verifier.service.js';
import { HttpWebhookTransport } from './network/http.transport.js';
import { resolveConfig } from './utils/resolve-config.util.js';
import type { ResolvedWebhooksConfig } from './interfaces/resolved-webhooks-config.interface.js';
import { WEBHOOKS_CONFIG } from './webhooks.constants.js';
import type { WebhooksModuleOptions } from './interfaces/webhooks-module-options.interface.js';
import { ConfigurableModuleClass, WEBHOOKS_MODULE_OPTIONS, type OPTIONS_TYPE } from './webhooks.module-definition.js';
import type { WebhooksModuleAsyncOptions, WebhooksModuleRootOptions, WebhooksModuleStructure } from './interfaces/webhooks-module-options.interface.js';
import { WebhooksEvents } from './events/webhooks-events.service.js';
import { WebhooksStorage } from './storage/webhooks.storage.js';
import { LOCK_STORAGE, STORAGE_USED } from './webhooks.constants.js';
import { WebhookDeliveries } from './services/webhook-deliveries.service.js';
import { WebhookEndpoints } from './services/webhook-endpoints.service.js';
import { WebhookFanOut } from './services/webhook-fan-out.service.js';
import { WebhookTransport } from './transports/webhook.transport.js';
import { WebhookWorker } from './services/webhook-worker.service.js';
import { Webhooks } from './webhooks.service.js';

/** Internal: `{ outgoing }`, for the module's startup checks. */
const WEBHOOKS_STRUCTURE = Symbol('WEBHOOKS_STRUCTURE');

/**
 * `WebhooksModule.forRoot({ eventTypes, retry, delivery, worker, receivers })`, or
 * `forRootAsync({ outgoing, transport, imports, inject, useFactory })`. Global by default.
 * Needs `OutboxModule`: sending dispatches through the outbox, and receiving deduplicates
 * with its inbox. Stores are providers of the app's that register with `WebhooksStorage`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: WEBHOOKS_CONFIG, inject: [WEBHOOKS_MODULE_OPTIONS], useFactory: (options?: WebhooksModuleOptions) => resolveConfig(options ?? {}) },
    WebhooksStorage,
    WebhooksEvents,
    WebhookVerifier,
  ],
  exports: [WebhooksStorage, WebhooksEvents, WebhookVerifier],
})
export class WebhooksModule extends ConfigurableModuleClass implements OnModuleInit {
  constructor(
    private readonly storage: WebhooksStorage,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    @Inject(WEBHOOKS_CONFIG) private readonly config: ResolvedWebhooksConfig,
    @Inject(WEBHOOKS_STRUCTURE) private readonly structure: { outgoing: boolean },
    @Optional() private readonly outbox?: Outbox,
    @Optional() private readonly inbox?: OutboxInbox,
  ) {
    super();
    storage[STORAGE_USED] = structure.outgoing;
  }

  static forRoot(options: WebhooksModuleRootOptions = {}): DynamicModule {
    return withStructure(super.forRoot(options as typeof OPTIONS_TYPE), options);
  }

  static forRootAsync(options: WebhooksModuleAsyncOptions): DynamicModule {
    return withStructure(super.forRootAsync(options), options);
  }

  /**
   * Every provider constructor has run (stores registered themselves), and the worker starts
   * later, in `onApplicationBootstrap`. Checks what can't wait for the first request.
   */
  onModuleInit() {
    if (this.structure.outgoing && !this.outbox) {
      throw new Error(
        'WebhooksModule needs @nestjs/outbox to send webhooks: import OutboxModule.forRoot() in the application module, ' +
          'or set `outgoing: false` in a service that only receives them.',
      );
    }

    this.checkReceivers();
    this.storage[LOCK_STORAGE]();
  }

  /** Every `@VerifyWebhook(name)` names a configured receiver, and deduplication has an inbox. */
  private checkReceivers() {
    const used = new Map<string, string>();

    for (const wrapper of this.discovery.getControllers()) {
      const { metatype } = wrapper;
      if (!metatype || typeof metatype !== 'function') {
        continue;
      }

      const onClass = Reflect.getMetadata(VERIFY_WEBHOOK_METADATA, metatype) as string | undefined;
      if (onClass) {
        used.set(onClass, metatype.name);
      }

      for (const method of this.scanner.getAllMethodNames(metatype.prototype)) {
        const name = Reflect.getMetadata(VERIFY_WEBHOOK_METADATA, metatype.prototype[method]) as string | undefined;
        if (name) {
          used.set(name, `${metatype.name}.${method}`);
        }
      }
    }

    const known = [...this.config.receivers.keys()];
    for (const [name, where] of used) {
      const receiver = this.config.receivers.get(name);
      if (!receiver) {
        throw new Error(
          `${where}: @VerifyWebhook('${name}') names no receiver. Configured in WebhooksModule \`receivers\`: ${known.join(', ') || 'none'}.`,
        );
      }

      if (receiver.dedupe && !this.inbox) {
        throw new Error(
          `${where}: receiver "${name}" deduplicates webhook ids with OutboxInbox, from @nestjs/outbox: import OutboxModule.forRoot() ` +
            `(relay: { enabled: false } in a service that only receives), or set \`dedupe: false\` on the receiver.`,
        );
      }
    }
  }
}

/** The providers `outgoing` and `transport` decide, added to the module `forRoot()`/`forRootAsync()` built. */
function withStructure(module: DynamicModule, structure: WebhooksModuleStructure): DynamicModule {
  const outgoing = structure.outgoing !== false;
  const providers: Provider[] = [{ provide: WEBHOOKS_STRUCTURE, useValue: { outgoing } }];
  const exports: DynamicModule['exports'] = [];

  if (outgoing) {
    providers.push(...transportProviders(structure.transport), WebhookWorker, WebhookFanOut, Webhooks, WebhookEndpoints, WebhookDeliveries);
    exports.push(WebhookTransport, WebhookWorker, Webhooks, WebhookEndpoints, WebhookDeliveries);
  } else if (structure.transport !== undefined) {
    throw new Error('WebhooksModule: `transport` sends webhooks, and `outgoing: false` sends none. Remove one of them.');
  }

  return {
    ...module,
    providers: [...(module.providers ?? []), ...providers],
    exports: [...(module.exports ?? []), ...exports],
  };
}

function transportProviders(top: WebhooksModuleStructure['transport']): Provider[] {
  if (typeof top === 'function') {
    return [
      top,
      {
        provide: WebhookTransport,
        inject: [WEBHOOKS_MODULE_OPTIONS, top],
        useFactory: (options: WebhooksModuleOptions | undefined, instance: WebhookTransport) => {
          if (options?.transport !== undefined) {
            throw setTwice();
          }
          return instance;
        },
      },
    ];
  }

  if (top !== undefined && typeof (top as WebhookTransport)?.send !== 'function') {
    throw new TypeError('WebhooksModule: `transport` must be a WebhookTransport class or an object with send()');
  }

  return [
    {
      provide: WebhookTransport,
      inject: [WEBHOOKS_MODULE_OPTIONS],
      useFactory: (options: WebhooksModuleOptions | undefined) => {
        const fromFactory = options?.transport;
        if (top !== undefined && fromFactory !== undefined) {
          throw setTwice();
        }

        if (fromFactory !== undefined) {
          if (typeof fromFactory === 'function') {
            throw new Error(
              `WebhooksModule: the forRootAsync() factory returned a class as \`transport\` (${(fromFactory as Type).name}). ` +
                'Classes go at the top level of forRootAsync(), where Nest instantiates them; the factory returns instances.',
            );
          }
          if (typeof (fromFactory as WebhookTransport).send !== 'function') {
            throw new TypeError('WebhooksModule: `transport` returned by the forRootAsync() factory must be a WebhookTransport instance');
          }
          return fromFactory;
        }
        return top ?? new HttpWebhookTransport(options?.delivery ?? {});
      },
    },
  ];
}

function setTwice(): Error {
  return new Error('WebhooksModule: `transport` is set both at the top level and in the options the factory returns. Set it in one place.');
}
