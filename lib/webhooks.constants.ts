/** Internal: the module options, checked and resolved once at startup. */
export const WEBHOOKS_CONFIG = Symbol('WEBHOOKS_CONFIG');

export const EVENT_TYPE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * The outbox topic a dispatched message travels on, to the package's in-process fan-out
 * handler. An app whose outbox also has transports routes it to `'local'`.
 */
export const WEBHOOKS_OUTBOX_TOPIC = 'nestjs.webhooks.message';

/** Internal: locks the registry. `WebhooksModule.onModuleInit()` and the first read call it. */
export const LOCK_STORAGE = Symbol('WebhooksStorage.lock');

/** Internal: whether the application sends webhooks (and so uses both contracts). `WebhooksModule` sets it. */
export const STORAGE_USED = Symbol('WebhooksStorage.used');

/** Internal: the receiver name `@VerifyWebhook()` stores. */
export const VERIFY_WEBHOOK_METADATA = 'nestjs:webhooks:receiver';

export const VERIFIED = Symbol('nestjs:webhooks:verified');
export const DEDUPED = Symbol('nestjs:webhooks:deduped');
