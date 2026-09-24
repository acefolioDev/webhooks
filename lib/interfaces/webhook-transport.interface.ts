/** One signed HTTP request for one attempt. */
export interface WebhookRequest {
  readonly url: string;
  /** `content-type`, `user-agent`, `webhook-id`, `webhook-timestamp`, `webhook-signature`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The message's body, byte for byte what was signed. */
  readonly body: string;
  readonly endpointId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly type: string;
}

export interface WebhookTransportSendOptions {
  /**
   * Aborts when the attempt outlives `delivery.timeout`: stop connecting, sending or reading,
   * and reject with `signal.reason`.
   */
  signal: AbortSignal;
  /** 1 for the first attempt of the round. */
  attempt: number;
}

/** What the endpoint answered. Any status is a response; throw only when there is none. */
export interface WebhookTransportResponse {
  statusCode: number;
  /** Lower-case names. The worker reads `retry-after`. */
  headers: Readonly<Record<string, string | undefined>>;
  /** The start of the body, as text, for the delivery log. */
  body: string;
}
