import { redactUrl } from '../utils/describe-error.util.js';
import { WebhooksError } from './webhooks.error.js';

/**
 * The delivery was refused before any byte left the process: the URL's scheme isn't allowed,
 * or its host is (or resolves to) an address in a blocked range (loopback, private,
 * link-local, cloud metadata...). Not retried: the endpoint must change its URL.
 */
export class WebhookDestinationBlockedError extends WebhooksError {
  constructor(
    readonly url: string,
    readonly reason: string,
    /** The address that was refused, when the refusal was about an address. */
    readonly address?: string,
  ) {
    super(`Refused to deliver to ${redactUrl(url)}: ${reason}`);
  }
}
