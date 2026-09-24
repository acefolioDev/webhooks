export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface HttpWebhookTransportOptions {
  /** Accept `http:` URLs. Default `false`. */
  allowHttp?: boolean;
  /** Deliver to loopback and private ranges. Default `false`. Link-local and metadata stay blocked. */
  allowPrivateNetworks?: boolean;
  /** CIDR ranges allowed although they'd be blocked. */
  allowedAddresses?: readonly string[];
  /** Bytes of the response body read; the rest is never read. Default 4096. */
  maxResponseSize?: number;
  /** Resolves a host name to every address it has. Default: the system resolver (`dns.lookup`). */
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /**
   * Certificate authorities to trust besides Node's (endpoints behind a private CA). Added
   * to Node's trust store, not put in its place as `node:tls`'s own `ca` option would be:
   * public endpoints keep verifying.
   */
  ca?: string | Buffer | readonly (string | Buffer)[];
}
