import { WebhookTransport } from './webhook.transport.js';
import type { WebhookRequest, WebhookTransportResponse, WebhookTransportSendOptions } from '../interfaces/webhook-transport.interface.js';
import { SentWebhook } from './sent-webhook.js';
import type { SentWebhookQuery, InMemoryWebhookResponder } from '../interfaces/in-memory-webhook-transport.interface.js';

/**
 * A transport that records every request instead of sending it, for tests:
 * `overrideProvider(WebhookTransport).useValue(new InMemoryWebhookTransport())`. It answers
 * 200 unless `respondWith()` says otherwise. No network, no address checks.
 */
export class InMemoryWebhookTransport extends WebhookTransport {
  readonly sent: SentWebhook[] = [];
  private responder: InMemoryWebhookResponder = () => 200;

  /**
   * Sets how the "endpoint" answers from now on: a status (`503`), a response
   * (`{ statusCode: 429, headers: { 'retry-after': '60' } }`), or a function of the request
   * and the attempt; throw inside it to simulate no response.
   */
  respondWith(responder: InMemoryWebhookResponder | number | Partial<WebhookTransportResponse>): this {
    this.responder = typeof responder === 'function' ? responder : () => responder;
    return this;
  }

  async send(request: WebhookRequest, { signal, attempt }: WebhookTransportSendOptions): Promise<WebhookTransportResponse> {
    signal.throwIfAborted();
    this.sent.push(new SentWebhook(request, attempt, new Date()));

    const answer = await this.responder(request, attempt);
    const response = typeof answer === 'number' ? { statusCode: answer } : answer;
    return { statusCode: response.statusCode ?? 200, headers: response.headers ?? {}, body: response.body ?? '' };
  }

  /** Requests matching `query`, oldest first. */
  filter(query: SentWebhookQuery = {}): SentWebhook[] {
    return this.sent.filter(typeof query === 'function' ? query : (sent) => matches(sent, query));
  }

  /** The one request matching `query`; throws, listing what was sent, when there are none or several. */
  single(query: SentWebhookQuery = {}): SentWebhook {
    const found = this.filter(query);
    if (found.length !== 1) {
      const list = this.sent.map((s) => `${s.type} -> ${s.url}`).join('; ') || 'nothing';
      throw new Error(`Expected one webhook matching the query, found ${found.length}. Sent: ${list}`);
    }
    return found[0]!;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

function matches(sent: SentWebhook, query: Exclude<SentWebhookQuery, (sent: SentWebhook) => boolean>): boolean {
  if (query.type !== undefined && sent.type !== query.type) {
    return false;
  }
  if (query.endpointId !== undefined && sent.endpointId !== query.endpointId) {
    return false;
  }
  if (query.messageId !== undefined && sent.messageId !== query.messageId) {
    return false;
  }
  if (query.url !== undefined) {
    if (typeof query.url === 'string' ? sent.url !== query.url : !query.url.test(sent.url)) {
      return false;
    }
  }
  return true;
}
