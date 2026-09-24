import { isIP } from 'node:net';
import type { AddressPolicy } from './address.policy.js';

const MAX_URL_LENGTH = 2_048;

/** A URL's host, as a socket needs it: IPv6 without brackets, the trailing dot of an absolute name removed. */
export function socketHost(url: URL): string {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** `localhost` and `*.localhost` always mean loopback (RFC 6761), whatever a resolver says. */
export function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * Checks what can be checked without DNS: the scheme, credentials, a fragment, the length,
 * and the host when it is an IP literal or a localhost name. Returns the parsed URL, or why
 * it is refused. The WHATWG parser has already normalized every IPv4 spelling (`0x7f.1`,
 * `2130706433`, `0177.0.0.1`, `127.1`) to a dotted quad, and IPv6 to its compressed form.
 */
export function checkDestination(
  raw: string,
  policy: AddressPolicy,
  allowHttp: boolean,
): { url: URL; reason?: undefined } | { url?: undefined; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { reason: 'the URL is empty' };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { reason: `the URL is longer than ${MAX_URL_LENGTH} characters` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'the URL is not valid' };
  }

  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { reason: allowHttp ? 'only http: and https: URLs are accepted' : 'only https: URLs are accepted' };
  }
  if (url.username || url.password) {
    return { reason: 'the URL carries credentials' };
  }
  if (url.hash) {
    return { reason: 'the URL has a fragment, which is never sent' };
  }

  const host = socketHost(url);
  if (host === '') {
    return { reason: 'the URL has no host' };
  }

  const literal = isIP(host) ? host : isLocalhostName(host) ? '127.0.0.1' : undefined;
  if (literal) {
    const verdict = policy.check(literal);
    if (!verdict.allowed) {
      return { reason: `${url.hostname} is ${verdict.reason}` };
    }
  }

  return { url };
}
