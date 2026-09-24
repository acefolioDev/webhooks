import { isIPv4, isIPv6 } from 'node:net';

/**
 * Which addresses a webhook may be delivered to. Every address, whether a URL's IP literal
 * or a DNS answer, goes through `check()` before a socket opens.
 *
 * - **Always blocked**: link-local (`169.254.0.0/16`, `fe80::/10`, where cloud metadata
 *   services live), known metadata addresses outside it (Azure `168.63.129.16`, Alibaba
 *   `100.100.100.200`, AWS `fd00:ec2::254`), and ranges no public host uses: documentation,
 *   benchmarking, multicast, reserved, broadcast, IETF protocol assignments, Teredo, and
 *   IPv6 outside `2000::/3`.
 * - **Private** (blocked unless `allowPrivateNetworks`): unspecified (`0.0.0.0/8`, `::`),
 *   loopback, RFC 1918, shared address space (`100.64.0.0/10`), unique local (`fc00::/7`).
 * - IPv6 forms that carry an IPv4 address (mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`,
 *   translated `::ffff:0:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are judged by
 *   the IPv4 address they carry.
 * - `allowedAddresses` ranges are allowed before any of that.
 */
export interface AddressPolicyOptions {
  allowPrivateNetworks?: boolean;
  allowedAddresses?: readonly string[];
}

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string };

interface Range {
  bytes: Uint8Array;
  prefix: number;
  label: string;
}

const v4 = (cidr: string, label: string): Range => {
  const [address, prefix] = cidr.split('/');
  return { bytes: new Uint8Array(parseIPv4(address!)!), prefix: Number(prefix), label };
};
const v6 = (cidr: string, label: string): Range => {
  const [address, prefix] = cidr.split('/');
  return { bytes: parseIPv6(address!)!, prefix: Number(prefix), label };
};

const METADATA: Range[] = [
  v4('168.63.129.16/32', 'a cloud metadata address'),
  v4('100.100.100.200/32', 'a cloud metadata address'),
  v6('fd00:ec2::254/128', 'a cloud metadata address'),
];

const ALWAYS_V4: Range[] = [
  v4('169.254.0.0/16', 'link-local (cloud metadata)'),
  v4('192.0.0.0/24', 'reserved (IETF protocol assignments)'),
  v4('192.0.2.0/24', 'reserved (documentation)'),
  v4('192.88.99.0/24', 'reserved (6to4 relay)'),
  v4('198.18.0.0/15', 'reserved (benchmarking)'),
  v4('198.51.100.0/24', 'reserved (documentation)'),
  v4('203.0.113.0/24', 'reserved (documentation)'),
  v4('224.0.0.0/4', 'multicast'),
  v4('240.0.0.0/4', 'reserved'),
];

const PRIVATE_V4: Range[] = [
  v4('0.0.0.0/8', 'unspecified'),
  v4('10.0.0.0/8', 'private'),
  v4('100.64.0.0/10', 'shared address space'),
  v4('127.0.0.0/8', 'loopback'),
  v4('172.16.0.0/12', 'private'),
  v4('192.168.0.0/16', 'private'),
];

const PRIVATE_V6: Range[] = [
  v6('::/128', 'unspecified'),
  v6('::1/128', 'loopback'),
  v6('fc00::/7', 'unique local (private)'),
];

const ALWAYS_V6: Range[] = [
  v6('fe80::/10', 'link-local'),
  v6('2001::/32', 'reserved (Teredo)'),
  v6('2001:10::/28', 'reserved (ORCHID)'),
  v6('2001:20::/28', 'reserved (ORCHIDv2)'),
  v6('2001:db8::/32', 'reserved (documentation)'),
  v6('3fff::/20', 'reserved (documentation)'),
];

const GLOBAL_UNICAST = v6('2000::/3', 'global unicast');

export class AddressPolicy {
  private readonly allowed: Range[];
  private readonly allowPrivate: boolean;

  /** Throws a `TypeError` naming the entry for a malformed `allowedAddresses` range. */
  constructor(options: AddressPolicyOptions = {}) {
    this.allowPrivate = options.allowPrivateNetworks === true;
    this.allowed = (options.allowedAddresses ?? []).map((cidr, index) => parseCidr(cidr, `delivery.allowedAddresses[${index}]`));
  }

  check(address: string): AddressVerdict {
    const bytes = parseIPv4(address) ?? parseIPv6(address);
    if (!bytes) {
      return { allowed: false, reason: `"${address}" is not an IP address` };
    }

    if (this.allowed.some((range) => contains(range, bytes))) {
      return { allowed: true };
    }

    return bytes.length === 4 ? this.checkV4(bytes) : this.checkV6(bytes);
  }

  private checkV4(bytes: Uint8Array, via = ''): AddressVerdict {
    for (const range of [...METADATA, ...ALWAYS_V4]) {
      if (contains(range, bytes)) {
        return { allowed: false, reason: `${via}${range.label}` };
      }
    }

    if (!this.allowPrivate) {
      for (const range of PRIVATE_V4) {
        if (contains(range, bytes)) {
          return { allowed: false, reason: `${via}${range.label}` };
        }
      }
    }

    if (bytes[0] === 255 && bytes[1] === 255 && bytes[2] === 255 && bytes[3] === 255) {
      return { allowed: false, reason: `${via}broadcast` };
    }

    return { allowed: true };
  }

  private checkV6(bytes: Uint8Array): AddressVerdict {
    const embedded = embeddedIPv4(bytes);
    if (embedded) {
      return this.checkV4(embedded.address, `${embedded.form} of `);
    }

    for (const range of METADATA) {
      if (contains(range, bytes)) {
        return { allowed: false, reason: range.label };
      }
    }

    for (const range of ALWAYS_V6) {
      if (contains(range, bytes)) {
        return { allowed: false, reason: range.label };
      }
    }

    for (const range of PRIVATE_V6) {
      if (contains(range, bytes)) {
        return this.allowPrivate ? { allowed: true } : { allowed: false, reason: range.label };
      }
    }

    if (!contains(GLOBAL_UNICAST, bytes)) {
      return { allowed: false, reason: 'reserved (outside 2000::/3)' };
    }

    return { allowed: true };
  }
}

/** The IPv4 address an IPv6 address carries, and in which form. */
function embeddedIPv4(bytes: Uint8Array): { address: Uint8Array; form: string } | undefined {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const last4 = bytes.slice(12, 16);

  // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { address: last4, form: 'IPv4-mapped' };
  }
  // ::ffff:0:a.b.c.d (translated, RFC 2765)
  if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return { address: last4, form: 'IPv4-translated' };
  }
  // ::a.b.c.d (compatible, deprecated), but not :: and ::1
  if (zeros(0, 12) && !zeros(12, 15)) {
    return { address: last4, form: 'IPv4-compatible' };
  }
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) {
    return { address: last4, form: 'NAT64' };
  }
  // 64:ff9b:1::/48 (local-use NAT64): the IPv4 address can sit anywhere; judge it as private.
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0 && bytes[5] === 1) {
    return { address: new Uint8Array([10, 0, 0, 0]), form: 'local-use NAT64' };
  }
  // 2002:a.b.c.d::/48 (6to4)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return { address: bytes.slice(2, 6), form: '6to4' };
  }
  return undefined;
}

function contains(range: Range, bytes: Uint8Array): boolean {
  if (range.bytes.length !== bytes.length) {
    return false;
  }

  let bits = range.prefix;
  for (let i = 0; i < bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (range.bytes[i]! & mask)) {
      return false;
    }
  }
  return true;
}

function parseCidr(cidr: string, option: string): Range {
  const [address, prefix, ...rest] = String(cidr).split('/');
  const bytes = parseIPv4(address ?? '') ?? parseIPv6(address ?? '');
  const bits = prefix === undefined ? (bytes?.length ?? 0) * 8 : Number(prefix);

  if (!bytes || rest.length > 0 || !Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8 || (prefix !== undefined && !/^\d+$/.test(prefix))) {
    throw new TypeError(`WebhooksModule: \`${option}\` must be an IP address or a CIDR range such as "10.20.0.0/16" (got ${JSON.stringify(cidr)})`);
  }

  return { bytes, prefix: bits, label: 'allowed' };
}

/** Four bytes of a dotted-quad IPv4 address (the canonical form URLs and DNS produce), or null. */
export function parseIPv4(address: string): Uint8Array | null {
  if (!isIPv4(address)) {
    return null;
  }
  return new Uint8Array(address.split('.').map(Number));
}

/** Sixteen bytes of an IPv6 address (brackets allowed), or null. */
export function parseIPv6(address: string): Uint8Array | null {
  const text = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (!isIPv6(text) || text.includes('%')) {
    return null;
  }
  let groups: string[];
  const tail: number[] = [];
  let body = text;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (dotted) {
    const quad = parseIPv4(dotted[1]!)!;
    tail.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
    body = body.slice(0, -dotted[1]!.length);
    if (body.endsWith(':') && !body.endsWith('::')) {
      body = body.slice(0, -1);
    }
  }
  const [head, rest] = body.split('::');
  const left = head ? head.split(':').filter((g) => g !== '') : [];
  if (rest !== undefined) {
    const right = rest ? rest.split(':').filter((g) => g !== '') : [];
    const fill = 8 - tail.length - left.length - right.length;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = left;
  }
  const words = [...groups.map((g) => parseInt(g, 16)), ...tail];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) {
    return null;
  }
  const bytes = new Uint8Array(16);
  words.forEach((word, i) => {
    bytes[i * 2] = word >> 8;
    bytes[i * 2 + 1] = word & 0xff;
  });
  return bytes;
}
