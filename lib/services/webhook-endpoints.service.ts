import { Inject, Injectable } from '@nestjs/common';
import { toMs } from '../utils/duration.util.js';
import type { Duration } from '../interfaces/duration.interface.js';
import { checkDestination } from '../network/destination.util.js';
import { checkPage } from '../utils/query.util.js';
import { generateSecret, standardSecretKey } from '../signing/secrets.util.js';
import type { ResolvedWebhooksConfig } from '../interfaces/resolved-webhooks-config.interface.js';
import { EVENT_TYPE, WEBHOOKS_CONFIG } from '../webhooks.constants.js';
import { InvalidWebhookEndpointError } from '../errors/invalid-webhook-endpoint.error.js';
import { WebhookEndpointNotFoundError } from '../errors/webhook-endpoint-not-found.error.js';
import type { WebhookEndpointPatch, WebhookEndpointRecord } from '../interfaces/webhook-endpoint-store.interface.js';
import type { WebhookEndpoint, WebhookEndpointQuery } from '../interfaces/webhook-endpoint.interface.js';
import { WebhooksStorage } from '../storage/webhooks.storage.js';
import { prefixedId } from '../utils/uuid.util.js';
import type { CreateWebhookEndpoint, UpdateWebhookEndpoint, WebhookTenantScope, CreatedWebhookEndpoint } from '../interfaces/webhook-endpoint.interface.js';

const MAX_EVENT_TYPES = 100;
const MAX_DESCRIPTION = 1_024;
const MAX_TENANT = 256;

/**
 * Manages endpoints (subscriptions): what a partner API calls. There is no built-in
 * controller: expose these behind your own authentication, passing the caller's tenant.
 */
@Injectable()
export class WebhookEndpoints {
  constructor(
    private readonly storage: WebhooksStorage,
    @Inject(WEBHOOKS_CONFIG) private readonly config: ResolvedWebhooksConfig,
  ) {}

  private get store() {
    return this.storage.endpoints;
  }

  /** Creates an endpoint with a new secret (or `input.secret`), enabled. */
  async create(input: CreateWebhookEndpoint): Promise<CreatedWebhookEndpoint> {
    const now = Date.now();
    const id = prefixedId('ep');
    const secret = input.secret === undefined ? generateSecret() : this.checkSecret(input.secret);

    const record: WebhookEndpointRecord = {
      id,
      tenant: this.checkTenant(input.tenant ?? null),
      url: this.checkUrl(input.url),
      eventTypes: this.checkEventTypes(input.eventTypes),
      description: this.checkDescription(input.description ?? null),
      enabled: true,
      disabledReason: null,
      failingSince: null,
      createdAt: now,
      updatedAt: now,
      secrets: [{ secret: this.config.secrets.seal(id, secret), createdAt: now, expiresAt: null }],
    };

    await this.store.createEndpoint(record);
    return { ...toPublic(record), secret };
  }

  async get(id: string, scope: WebhookTenantScope = {}): Promise<WebhookEndpoint | undefined> {
    const record = await this.find(id, scope);
    return record && toPublic(record);
  }

  /** Newest first. */
  async list(query: WebhookEndpointQuery = {}): Promise<WebhookEndpoint[]> {
    return (await this.store.listEndpoints(checkPage(query, 'WebhookEndpoints.list()'))).map(toPublic);
  }

  async update(id: string, changes: UpdateWebhookEndpoint, scope: WebhookTenantScope = {}): Promise<WebhookEndpoint> {
    await this.require(id, scope);

    const patch: WebhookEndpointPatch = {};
    if (changes.url !== undefined) {
      patch.url = this.checkUrl(changes.url);
    }
    if (changes.eventTypes !== undefined) {
      patch.eventTypes = this.checkEventTypes(changes.eventTypes);
    }
    if (changes.description !== undefined) {
      patch.description = this.checkDescription(changes.description);
    }
    if (changes.enabled === true) {
      Object.assign(patch, { enabled: true, disabledReason: null, failingSince: null });
    }
    if (changes.enabled === false) {
      Object.assign(patch, { enabled: false, disabledReason: 'manual' });
    }

    const updated = await this.store.updateEndpoint(id, patch, Date.now());
    if (!updated) {
      throw new WebhookEndpointNotFoundError(id);
    }

    return toPublic(updated);
  }

  /** Deletes the endpoint. Its pending deliveries fail (`endpoint-deleted`) when their turn comes; the log stays. */
  async delete(id: string, scope: WebhookTenantScope = {}): Promise<void> {
    await this.require(id, scope);
    if (!(await this.store.deleteEndpoint(id))) {
      throw new WebhookEndpointNotFoundError(id);
    }
  }

  /** The secret that signs now (the newest), for the endpoint's owner to verify with. */
  async getSecret(id: string, scope: WebhookTenantScope = {}): Promise<string> {
    const record = await this.require(id, scope);
    const now = Date.now();
    const live = record.secrets.find((secret) => secret.expiresAt === null || secret.expiresAt > now);

    if (!live) {
      throw new WebhookEndpointNotFoundError(id);
    }
    return this.config.secrets.open(id, live.secret);
  }

  /**
   * Replaces the signing secret. The old one keeps signing next to the new one for `overlap`
   * (default `secretRotationOverlap`, 24h), so the receiver can switch without dropping a
   * webhook; `overlap: 0` retires it at once (a leaked secret). Returns the new secret.
   */
  async rotateSecret(id: string, options: WebhookTenantScope & { overlap?: Duration; secret?: string } = {}): Promise<string> {
    await this.require(id, options);
    const now = Date.now();
    const overlap = options.overlap === undefined ? this.config.rotationOverlapMs : toMs(options.overlap);
    const secret = options.secret === undefined ? generateSecret() : this.checkSecret(options.secret);

    const added = await this.store.addEndpointSecret(
      id,
      { secret: this.config.secrets.seal(id, secret), createdAt: now, expiresAt: null },
      now + overlap,
      now,
    );

    if (!added) {
      throw new WebhookEndpointNotFoundError(id);
    }
    return secret;
  }

  private async find(id: string, { tenant }: WebhookTenantScope): Promise<WebhookEndpointRecord | undefined> {
    if (typeof id !== 'string' || id === '') {
      return undefined;
    }

    const record = await this.store.getEndpoint(id);
    if (!record || (tenant !== undefined && record.tenant !== tenant)) {
      return undefined;
    }
    return record;
  }

  private async require(id: string, scope: WebhookTenantScope): Promise<WebhookEndpointRecord> {
    const record = await this.find(id, scope);
    if (!record) {
      throw new WebhookEndpointNotFoundError(id);
    }
    return record;
  }

  private checkUrl(url: unknown): string {
    const checked = checkDestination(url as string, this.config.addressPolicy, this.config.allowHttp);
    if (!checked.url) {
      throw new InvalidWebhookEndpointError('url', `Invalid webhook URL: ${checked.reason}`);
    }
    return checked.url.href;
  }

  private checkEventTypes(types: unknown): string[] {
    if (!Array.isArray(types) || types.length === 0) {
      throw new InvalidWebhookEndpointError('eventTypes', 'eventTypes must list at least one message type (or "*")');
    }
    if (types.length > MAX_EVENT_TYPES) {
      throw new InvalidWebhookEndpointError('eventTypes', `eventTypes lists more than ${MAX_EVENT_TYPES} types`);
    }

    for (const type of types) {
      if (type === '*') {
        continue;
      }
      if (typeof type !== 'string' || !EVENT_TYPE.test(type)) {
        throw new InvalidWebhookEndpointError('eventTypes', `${JSON.stringify(type)} is not a message type`);
      }
      if (this.config.eventTypes && !this.config.eventTypes.has(type)) {
        throw new InvalidWebhookEndpointError('eventTypes', `Unknown message type "${type}". Known: ${[...this.config.eventTypes].join(', ')}`);
      }
    }

    return [...new Set(types as string[])];
  }

  private checkDescription(description: unknown): string | null {
    if (description === null) {
      return null;
    }
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
      throw new InvalidWebhookEndpointError('description', `description must be a string of at most ${MAX_DESCRIPTION} characters`);
    }
    return description;
  }

  private checkTenant(tenant: unknown): string | null {
    if (tenant === null) {
      return null;
    }
    if (typeof tenant !== 'string' || tenant === '' || tenant.length > MAX_TENANT) {
      throw new InvalidWebhookEndpointError('tenant', `tenant must be null or a non-empty string of at most ${MAX_TENANT} characters`);
    }
    return tenant;
  }

  private checkSecret(secret: unknown): string {
    try {
      standardSecretKey(secret as string);
    } catch (error) {
      throw new InvalidWebhookEndpointError('secret', `Invalid secret: ${(error as Error).message}`);
    }
    return secret as string;
  }
}

function toPublic({ secrets: _secrets, ...endpoint }: WebhookEndpointRecord): WebhookEndpoint {
  return endpoint;
}
