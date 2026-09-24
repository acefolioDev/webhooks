import type { Duration } from './duration.interface.js';
import type { WebhookTransport } from '../transports/webhook.transport.js';
import type { WebhookDelivery } from './webhook-delivery.interface.js';
import type { WebhookReceiverOptions } from './webhook-receiver-options.interface.js';
import type { ConfigurableModuleAsyncOptions, ModuleMetadata, Type } from '@nestjs/common';

export interface WebhookBackoffOptions {
  /** Wait before the first retry. Default `'5s'`. */
  delay?: Duration;
  /** Growth per retry; 1 = constant. Default 4. */
  factor?: number;
  /** Cap for a single wait, and for what a `Retry-After` header may ask. Default `'1d'`. */
  maxDelay?: Duration;
  /** `equal` (default): uniformly in [d/2, d]. `full`: in [0, d]. `none`: exactly d. */
  jitter?: 'full' | 'equal' | 'none';
}

export interface WebhookRetryOptions {
  /** Total attempts per delivery, including the first. Default 10 (about two days). */
  attempts?: number;
  /** `attempt` is the number of the attempt that just failed (1-based). */
  backoff?: WebhookBackoffOptions | ((attempt: number, error: unknown, delivery: WebhookDelivery) => Duration);
  /**
   * Return false to fail the delivery at once. Never asked about a blocked destination,
   * `NonRetryableWebhookError` or 410 Gone, which are never retried.
   */
  retryIf?: (error: unknown, attempt: number, delivery: WebhookDelivery) => boolean;
}

/** How the built-in transport sends, and what it refuses to reach. */
export interface WebhookDeliveryOptions {
  /** One attempt: DNS, connect, TLS, request, response. Default `'15s'`. */
  timeout?: Duration;
  /** Accept `http:` endpoint URLs. Default `false` (https only). For development. */
  allowHttp?: boolean;
  /**
   * Deliver to loopback, private (RFC 1918, unique local) and CGNAT addresses. Default
   * `false`. For development. Link-local and cloud metadata addresses stay blocked.
   */
  allowPrivateNetworks?: boolean;
  /** CIDR ranges (`10.20.0.0/16`, `fd12::/64`) delivered to although they'd be blocked. */
  allowedAddresses?: readonly string[];
  /** Bytes of the response body read and kept in the log; the rest is never read. Default 4096. */
  maxResponseSize?: number;
  /** Default `NestJS-Webhooks/1.0`. */
  userAgent?: string;
}

export interface WebhookWorkerOptions {
  /** Deliver in this process. Default `true`; `false` in instances that only dispatch. */
  enabled?: boolean;
  /** Wait between polls when idle. Default `'1s'`. */
  pollInterval?: Duration;
  /** Deliveries claimed per poll. Default 50. */
  batchSize?: number;
  /** Endpoints delivered to in parallel (each endpoint's deliveries go one at a time). Default 10. */
  concurrency?: number;
  /** How long a claim is exclusive. Default `'1m'`; longer than `delivery.timeout`. */
  lease?: Duration;
}

/** Encryption of endpoint secrets at rest: the family's shape (the first key encrypts, every key decrypts). */
export interface WebhookEncryptionOptions {
  /** 32-byte Buffers or strings of at least 32 characters, newest first. */
  keys: readonly (string | Buffer)[];
}

/**
 * The options `forRootAsync()`'s factory returns. `forRoot()` takes the same at its top
 * level, where `transport` may also be a class. Stores are not options: a provider registers
 * them with `WebhooksStorage.registerSource()`.
 */
export interface WebhooksModuleOptions {
  /** The message types this app sends. When set, `dispatch()` and endpoints accept only these. */
  eventTypes?: readonly string[];
  /** `5` means `{ attempts: 5 }`, `false` a single attempt. Default: 10 attempts, 5s growing ×4 to a 1d cap. */
  retry?: number | false | WebhookRetryOptions;
  delivery?: WebhookDeliveryOptions;
  worker?: WebhookWorkerOptions;
  /** Disable an endpoint after it has failed this long without a success. Default `'5d'`; `false` never. */
  disableEndpointAfter?: Duration | false;
  /** How long a rotated-out secret keeps signing, next to the new one. Default `'24h'`. */
  secretRotationOverlap?: Duration;
  encryption?: WebhookEncryptionOptions;
  /** Incoming webhooks: the senders you accept, by name, for `@VerifyWebhook(name)`. */
  receivers?: Record<string, WebhookReceiverOptions>;
  /** A transport instance (a class goes at the top level). Default: the SSRF-guarded HTTP transport. */
  transport?: WebhookTransport;
  /**
   * With `NODE_ENV=production`, startup fails while the endpoints or deliveries store isn't
   * registered. `true` accepts the in-memory store anyway. Default `false`.
   */
  allowInMemoryStorage?: boolean;
}

/**
 * The top level of both `forRoot()` and `forRootAsync()`: what must be known when the module
 * is defined. Classes Nest instantiates go only here, never in the async factory's result.
 */
export interface WebhooksModuleStructure {
  /**
   * `false` in a service that only receives webhooks: no endpoints, deliveries, worker or
   * outbox handler, and no stores to register. Default `true`.
   */
  outgoing?: boolean;
  /** A `WebhookTransport` class (Nest instantiates it, with DI) or instance. Default: the SSRF-guarded HTTP transport. */
  transport?: Type<WebhookTransport> | WebhookTransport;
  /** Modules whose exports a transport class injects (`forRootAsync()` has its own `imports`). */
  imports?: ModuleMetadata['imports'];
  /** Default `true`. */
  isGlobal?: boolean;
}

/** `forRoot()`'s options: everything at the top level, where `transport` may be a class. */
export type WebhooksModuleRootOptions = Omit<WebhooksModuleOptions, 'transport'> & WebhooksModuleStructure;

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface WebhooksOptionsFactory {
  createWebhooksOptions(): WebhooksModuleOptions | Promise<WebhooksModuleOptions>;
}

/**
 * What `forRootAsync()` takes: `outgoing`, `transport`, `imports` and `isGlobal` at the top
 * level, and one of `useFactory`, `useClass` or `useExisting` for the rest.
 */
export type WebhooksModuleAsyncOptions = ConfigurableModuleAsyncOptions<WebhooksModuleOptions, 'createWebhooksOptions'> &
  WebhooksModuleStructure;
