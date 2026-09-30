import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { WebhooksModuleOptions } from '../interfaces/webhooks-module-options.interface.js';
import { WEBHOOKS_MODULE_OPTIONS } from '../webhooks.module-definition.js';
import type { WebhookEndpointStore } from '../interfaces/webhook-endpoint-store.interface.js';
import type { WebhookDeliveryStore } from '../interfaces/webhook-delivery-store.interface.js';
import { WEBHOOK_DELIVERY_STORE_METHODS, WEBHOOK_ENDPOINT_STORE_METHODS } from './webhooks-storage.constants.js';
import { InMemoryWebhookStore } from '../stores/in-memory-webhook.store.js';
import { LOCK_STORAGE, STORAGE_USED } from '../webhooks.constants.js';
import type { WebhooksStorageSources, WebhooksStorageContract, WebhooksStorageRegisterOptions } from '../interfaces/webhooks-storage.interface.js';

interface ContractSpec {
  interfaceName: string;
  /** What in-memory storage loses, for the production guard. */
  holds: string;
  methods: readonly string[];
}

const CONTRACTS: Record<WebhooksStorageContract, ContractSpec> = {
  endpoints: { interfaceName: 'WebhookEndpointStore', holds: 'endpoints and their secrets', methods: WEBHOOK_ENDPOINT_STORE_METHODS },
  deliveries: { interfaceName: 'WebhookDeliveryStore', holds: 'pending deliveries and the delivery log', methods: WEBHOOK_DELIVERY_STORE_METHODS },
};
const CONTRACT_NAMES = Object.keys(CONTRACTS) as WebhooksStorageContract[];
const KNOWN = CONTRACT_NAMES.map((name) => `${name} (${CONTRACTS[name].interfaceName})`).join(', ');
const DEFAULT = 'InMemoryWebhookStore (the default: state is lost on restart and not shared between instances)';

/**
 * The registry the webhooks package reads its stores from. Your store provider registers
 * itself in its constructor, naming the contracts it implements:
 *
 * ```ts
 * @Injectable()
 * export class DrizzleWebhookStore implements WebhookEndpointStore, WebhookDeliveryStore {
 *   constructor(@InjectDrizzle() private readonly db: Database, storage: WebhooksStorage) {
 *     storage.registerSource({ endpoints: this, deliveries: this });
 *   }
 * }
 * ```
 *
 * A contract no source registered uses `InMemoryWebhookStore`. The registry locks in
 * `WebhooksModule`'s `onModuleInit`, or at the first read of a store if that is earlier.
 * Production guard: at the lock, with `NODE_ENV=production`, an application that sends
 * webhooks must have registered both, unless `allowInMemoryStorage` is set; one that only
 * receives (`outgoing: false`) uses neither.
 */
@Injectable()
export class WebhooksStorage {
  private readonly logger = new Logger('WebhooksModule');
  private readonly registered = new Map<WebhooksStorageContract, object>();
  private readonly active = new Map<WebhooksStorageContract, object>();
  private fallback?: InMemoryWebhookStore;
  private locked = false;
  /** Internal: see {@link STORAGE_USED}. Without it (a registry built with `new`), both contracts count as used. */
  [STORAGE_USED] = true;

  constructor(@Optional() @Inject(WEBHOOKS_MODULE_OPTIONS) private readonly options?: WebhooksModuleOptions) {}

  /**
   * Registers stores by contract: `{ endpoints: this, deliveries: this }`. Call it from the
   * constructor of a singleton provider. Throws, registering nothing, when a store lacks a
   * method of its contract, when a contract already has a source (unless `replace`), and
   * once the registry has locked.
   */
  registerSource(sources: WebhooksStorageSources, options: WebhooksStorageRegisterOptions = {}): void {
    const entries = validate(sources);

    if (this.locked) {
      throw new Error(
        `WebhooksStorage.registerSource(): ${describe(entries)} registered after WebhooksModule initialized (or after ` +
          `its storage was first read), which already uses ${this.summary()}. Register from the ` +
          'constructor of a singleton provider: providers of lazy-loaded modules, request-scoped and transient ' +
          'providers, and lifecycle hooks run too late.',
      );
    }

    if (!options.replace) {
      for (const [contract, source] of entries) {
        const previous = this.registered.get(contract);
        if (previous) {
          throw new Error(
            `WebhooksStorage.registerSource(): ${nameOf(source)} can't register \`${contract}\`, ` +
              `${previous === source ? 'it already did (the same instance, twice)' : `${nameOf(previous)} already did`}. ` +
              'Register each contract once, or pass { replace: true } to replace it on purpose (tests, wrappers).',
          );
        }
      }
    }

    for (const [contract, source] of entries) {
      this.registered.set(contract, source);
    }
  }

  /** The endpoint store in use: the registered one, or the in-memory default. Reading it locks the registry. */
  get endpoints(): WebhookEndpointStore {
    return this.source('endpoints') as WebhookEndpointStore;
  }

  /** The delivery store in use: the registered one, or the in-memory default. Reading it locks the registry. */
  get deliveries(): WebhookDeliveryStore {
    return this.source('deliveries') as WebhookDeliveryStore;
  }

  /** Freezes the sources, logs them, and enforces the production guard (which leaves the registry open). */
  [LOCK_STORAGE](): void {
    if (this.locked) {
      return;
    }

    const missing = this[STORAGE_USED] ? CONTRACT_NAMES.filter((contract) => !this.registered.has(contract)) : [];
    if (missing.length > 0 && this.refusesInMemory()) {
      throw new Error(productionError(missing));
    }

    this.locked = true;
    for (const [contract, source] of this.registered) {
      this.active.set(contract, source);
    }

    if (this[STORAGE_USED] || this.registered.size > 0) {
      this.logger.log(`WebhooksStorage: ${this.summary()}`);
    }
  }

  private source(contract: WebhooksStorageContract): object {
    this[LOCK_STORAGE]();

    let source = this.active.get(contract);
    if (!source) {
      // Read although the configuration says it isn't used: never in memory in production either.
      if (this.refusesInMemory()) {
        throw new Error(productionError([contract]));
      }
      source = this.fallback ??= new InMemoryWebhookStore();
      this.active.set(contract, source);
    }

    return source;
  }

  private refusesInMemory(): boolean {
    return process.env.NODE_ENV === 'production' && !this.options?.allowInMemoryStorage;
  }

  /** `DrizzleWebhookStore`, or `EndpointStore (endpoints); in-memory (deliveries)`. */
  private summary(): string {
    const sources = new Set(this.registered.values());
    if (sources.size === 0) {
      return DEFAULT;
    }
    if (sources.size === 1 && this.registered.size === CONTRACT_NAMES.length) {
      return nameOf([...sources][0]);
    }

    const groups = new Map<string, string[]>();
    for (const contract of CONTRACT_NAMES) {
      const source = this.registered.get(contract);
      const name = source ? nameOf(source) : 'in-memory';
      groups.set(name, [...(groups.get(name) ?? []), contract]);
    }

    return [...groups].map(([name, contracts]) => `${name} (${contracts.join(', ')})`).join('; ');
  }
}

/** The `[contract, store]` pairs of a `registerSource()` argument, after checking every one. */
function validate(sources: WebhooksStorageSources): [WebhooksStorageContract, object][] {
  if (sources === null || typeof sources !== 'object') {
    throw new TypeError(`WebhooksStorage.registerSource(): the contracts go by name, and got ${nameOf(sources)}. ${usage()}`);
  }

  // A store passed as itself (`registerSource(this)`): say which call it meant.
  const implemented = CONTRACT_NAMES.filter((contract) =>
    CONTRACTS[contract].methods.some((method) => typeof (sources as Record<string, unknown>)[method] === 'function'),
  );
  if (implemented.length > 0) {
    throw new TypeError(
      `WebhooksStorage.registerSource(): the contracts go by name, and ${nameOf(sources)} was passed as itself. ` +
        `Name what it implements: \`registerSource({ ${implemented.map((contract) => `${contract}: this`).join(', ')} })\`.`,
    );
  }

  const keys = Object.keys(sources);
  if (keys.length === 0) {
    throw new TypeError(`WebhooksStorage.registerSource(): the contracts go by name, and got none. ${usage()}`);
  }

  const unknown = keys.filter((key) => !Object.hasOwn(CONTRACTS, key));
  if (unknown.length > 0) {
    throw new TypeError(
      `WebhooksStorage.registerSource(): unknown contract ${unknown.map((key) => `\`${key}\``).join(', ')}. ` +
        `The contracts are ${KNOWN}.`,
    );
  }

  return (keys as WebhooksStorageContract[]).map((contract) => {
    const source = sources[contract] as unknown;
    const { interfaceName, methods } = CONTRACTS[contract];

    if (source === null || typeof source !== 'object') {
      throw new TypeError(
        `WebhooksStorage.registerSource(): expected an object implementing ${interfaceName} as \`${contract}\`, ` +
          `got ${nameOf(source)}.`,
      );
    }

    const missing = methods.filter((method) => typeof (source as Record<string, unknown>)[method] !== 'function');
    if (missing.length > 0) {
      throw new TypeError(
        `WebhooksStorage.registerSource(): ${nameOf(source)} doesn't implement ${interfaceName} for \`${contract}\`: ` +
          `${missing.map((method) => `${method}()`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
      );
    }

    return [contract, source];
  });
}

function usage(): string {
  return `Pass the stores a provider implements: \`registerSource({ endpoints: this, deliveries: this })\`. The contracts are ${KNOWN}.`;
}

function productionError(missing: WebhooksStorageContract[]): string {
  const specs = missing.map((contract) => CONTRACTS[contract]);
  const example = missing.map((contract) => `${contract}: this`).join(', ');

  return (
    `WebhooksStorage: no store is registered for ${and(missing.map((contract, i) => `\`${contract}\` (${specs[i]!.interfaceName})`))}, ` +
    `and NODE_ENV is "production": in memory, ${and(specs.map((spec) => spec.holds))} would be lost on restart and not ` +
    'shared between instances. Register a store on your database: PostgresWebhookStore (@nestjs/webhooks/postgres), ' +
    `MySqlWebhookStore (@nestjs/webhooks/mysql), or your own ${and(specs.map((spec) => spec.interfaceName))} in a ` +
    `provider that injects WebhooksStorage and calls \`storage.registerSource({ ${example} })\` in its constructor. Or ` +
    'set `allowInMemoryStorage: true` in the WebhooksModule options to run in memory anyway.'
  );
}

/** `a`, `a and b`, `a, b, and c`. */
function and(items: string[]): string {
  if (items.length <= 2) {
    return items.join(' and ');
  }
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/** How a message names a value: its class, or what it is instead of an instance. */
function nameOf(value: unknown): string {
  if (typeof value === 'function') {
    return `the class ${value.name || '(anonymous)'} (pass an instance)`;
  }
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  const name = (value as object).constructor?.name;
  return name && name !== 'Object' ? name : 'an object';
}

/** `AppWebhookStore (endpoints, deliveries)`: the sources of a `registerSource()` call. */
function describe(entries: [WebhooksStorageContract, object][]): string {
  const names = [...new Set(entries.map(([, source]) => nameOf(source)))].join(', ');
  return `${names} (${entries.map(([contract]) => contract).join(', ')})`;
}
