/**
 * Server-side request forgery: every way a customer-supplied URL could reach inside the
 * network, against the address policy and against the HTTP transport with real sockets.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import { AddressPolicy } from '../lib/network/address.policy.js';
import { checkDestination } from '../lib/network/destination.util.js';
import { trustedCertificates } from '../lib/network/http.transport.js';
import { HttpWebhookTransport, WebhookDestinationBlockedError, type ResolvedAddress, type WebhookRequest } from '../lib/index.js';

const request = (url: string): WebhookRequest => ({
  url,
  headers: { 'content-type': 'application/json', 'webhook-id': 'msg_1' },
  body: '{"type":"order.shipped"}',
  endpointId: 'ep_1',
  deliveryId: 'dlv_1',
  messageId: 'msg_1',
  type: 'order.shipped',
});
const send = (transport: HttpWebhookTransport, url: string, signal = AbortSignal.timeout(5_000)) =>
  transport.send(request(url), { signal, attempt: 1 });

describe('AddressPolicy', () => {
  const strict = new AddressPolicy();
  const dev = new AddressPolicy({ allowPrivateNetworks: true });

  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'shared address space'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique local'],
    ['fdab:cdef::1', 'unique local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped of loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped of loopback'],
    ['::ffff:10.1.2.3', 'IPv4-mapped of private'],
    ['::ffff:0:127.0.0.1', 'IPv4-translated of loopback'],
    ['::127.0.0.1', 'IPv4-compatible of loopback'],
    ['64:ff9b::7f00:1', 'NAT64 of loopback'],
    ['64:ff9b::a00:1', 'NAT64 of private'],
    ['64:ff9b:1::1', 'local-use NAT64 of private'],
    ['2002:7f00:1::1', '6to4 of loopback'],
    ['2002:c0a8:101::1', '6to4 of private'],
  ])('blocks %s (%s) unless private networks are allowed', (address, reason) => {
    expect(strict.check(address)).toEqual({ allowed: false, reason: expect.stringContaining(reason) });
    expect(dev.check(address)).toEqual({ allowed: true });
  });

  it.each([
    ['169.254.169.254', 'link-local'],
    ['169.254.170.2', 'link-local'],
    ['168.63.129.16', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link-local'],
    ['::ffff:169.254.169.254', 'IPv4-mapped of link-local'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of link-local'],
    ['2002:a9fe:a9fe::', '6to4 of link-local'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.0.192', 'IETF'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['ff02::1', 'outside 2000::/3'],
    ['100::1', 'outside 2000::/3'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
  ])('always blocks %s (%s), even with private networks allowed', (address, reason) => {
    expect(strict.check(address)).toEqual({ allowed: false, reason: expect.stringContaining(reason) });
    expect(dev.check(address)).toEqual({ allowed: false, reason: expect.stringContaining(reason) });
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])('allows the public %s', (address) => {
    expect(strict.check(address)).toEqual({ allowed: true });
  });

  it('allows listed ranges first, and refuses malformed ranges at startup', () => {
    const policy = new AddressPolicy({ allowedAddresses: ['10.20.0.0/16', '169.254.169.254', 'fd12::/64'] });
    expect(policy.check('10.20.3.4')).toEqual({ allowed: true });
    expect(policy.check('10.21.0.1').allowed).toBe(false);
    expect(policy.check('169.254.169.254')).toEqual({ allowed: true });
    expect(policy.check('fd12::5')).toEqual({ allowed: true });
    expect(() => new AddressPolicy({ allowedAddresses: ['10.0.0.0/33'] })).toThrow(/allowedAddresses\[0\]/);
    expect(() => new AddressPolicy({ allowedAddresses: ['example.com'] })).toThrow(/allowedAddresses\[0\]/);
    expect(() => new AddressPolicy({ allowedAddresses: ['10.0.0.0/8/1'] })).toThrow();
  });
});

describe('checkDestination (URLs, before any DNS)', () => {
  const policy = new AddressPolicy();

  // The WHATWG parser normalizes every spelling of an IPv4 address before the check.
  it.each([
    'https://127.0.0.1/',
    'https://127.1/',
    'https://0x7f.0.0.1/',
    'https://0x7f000001/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://017700000001/',
    'https://127.0.0.1./',
    'https://0/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://[::]/',
    'https://localhost/',
    'https://LOCALHOST./',
    'https://api.localhost/',
    'https://169.254.169.254/latest/meta-data/',
    'https://0xa9.0xfe.0xa9.0xfe/',
    'https://[fd00:ec2::254]/',
    'https://[fe80::1]/',
    'https://①②⑦.0.0.1/',
  ])('refuses %s', (url) => {
    expect(checkDestination(url, policy, false)).toEqual({ reason: expect.any(String) });
  });

  it.each([
    ['http://hooks.example.com/', /only https/],
    ['ftp://hooks.example.com/', /only https/],
    ['file:///etc/passwd', /only https/],
    ['gopher://127.0.0.1:6379/_FLUSHALL', /only https/],
    ['javascript:alert(1)', /only https/],
    ['https://user:pass@hooks.example.com/', /credentials/],
    ['https://hooks.example.com/#frag', /fragment/],
    ['not a url', /not valid/],
    [`https://hooks.example.com/${'a'.repeat(2_100)}`, /longer than/],
  ])('refuses %s', (url, reason) => {
    expect(checkDestination(url, policy, false).reason).toMatch(reason);
  });

  it('accepts a public https URL, and http only when allowed', () => {
    expect(checkDestination('https://hooks.example.com/store?x=1', policy, false).url?.href).toBe('https://hooks.example.com/store?x=1');
    expect(checkDestination('http://hooks.example.com/', policy, true).url).toBeDefined();
  });
});

describe('HttpWebhookTransport with real sockets', () => {
  let server: Server;
  let port: number;
  const received: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    received.length = 0;
    handler = (_req, res) => res.writeHead(204).end();
  });

  /** A resolver that answers from a table and counts the questions. */
  const resolver = (answers: (hostname: string, call: number) => ResolvedAddress[]) => {
    const calls: string[] = [];
    return {
      calls,
      lookup: async (hostname: string) => {
        calls.push(hostname);
        return answers(hostname, calls.length);
      },
    };
  };

  it('refuses http and loopback by default, before any byte is sent', async () => {
    await expect(send(new HttpWebhookTransport(), `http://127.0.0.1:${port}/`)).rejects.toThrow(/only https/);
    await expect(send(new HttpWebhookTransport({ allowHttp: true }), `http://127.0.0.1:${port}/`)).rejects.toThrow(
      WebhookDestinationBlockedError,
    );
    await expect(send(new HttpWebhookTransport({ allowHttp: true }), `http://localhost:${port}/`)).rejects.toThrow(/loopback/);
    await expect(send(new HttpWebhookTransport({ allowHttp: true }), `http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(/loopback/);
    expect(received).toEqual([]);
  });

  it('refuses a name when any address it resolves to is blocked', async () => {
    const dns = resolver((hostname) =>
      hostname === 'mixed.test'
        ? [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ]
        : hostname === 'mapped.test'
          ? [{ address: '::ffff:169.254.169.254', family: 6 }]
          : [{ address: '10.0.0.5', family: 4 }],
    );
    const transport = new HttpWebhookTransport({ allowHttp: true, lookup: dns.lookup });

    const error = await send(transport, `http://internal.test:${port}/`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookDestinationBlockedError);
    expect(error).toMatchObject({ address: '10.0.0.5', reason: 'internal.test resolves to 10.0.0.5, private' });
    await expect(send(transport, `http://mixed.test:${port}/`)).rejects.toThrow(/resolves to 127.0.0.1, loopback/);
    await expect(send(transport, `http://mapped.test:${port}/`)).rejects.toThrow(/IPv4-mapped of link-local/);
    expect(received).toEqual([]);
  });

  it('connects to the address it checked: a resolver that changes its answer (DNS rebinding) is asked once', async () => {
    // The first answer is allowed (listed); every later one points at a private address.
    const dns = resolver((_hostname, call) => [{ address: call === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }]);
    const transport = new HttpWebhookTransport({ allowHttp: true, allowedAddresses: ['127.0.0.1/32'], lookup: dns.lookup });

    const response = await send(transport, `http://rebind.test:${port}/hooks?x=1`);
    expect(response.statusCode).toBe(204);
    expect(dns.calls).toEqual(['rebind.test']);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ url: '/hooks?x=1', headers: { host: `rebind.test:${port}`, 'webhook-id': 'msg_1' } });
    expect(received[0]!.body).toBe('{"type":"order.shipped"}');
  });

  it('never follows a redirect, even to an allowed address', async () => {
    handler = (_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` }).end();
    const transport = new HttpWebhookTransport({ allowHttp: true, allowPrivateNetworks: true });
    const response = await send(transport, `http://127.0.0.1:${port}/start`);
    expect(response.statusCode).toBe(302);
    expect(received.map((r) => r.url)).toEqual(['/start']);
  });

  it('reads at most maxResponseSize bytes of a large body, then closes the connection', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 'x');
      let sent = 0;
      const write = () => {
        while (sent < 50 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            return res.once('drain', write);
          }
        }
        res.end();
      };
      res.on('close', () => (sent = Infinity));
      write();
    };
    const transport = new HttpWebhookTransport({ allowHttp: true, allowPrivateNetworks: true, maxResponseSize: 1_000 });
    const started = performance.now();
    const response = await send(transport, `http://127.0.0.1:${port}/`);
    expect(response.body).toBe('x'.repeat(1_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('gives up on a server that never answers, and on one that trickles its body', async () => {
    handler = () => {}; // never responds
    const transport = new HttpWebhookTransport({ allowHttp: true, allowPrivateNetworks: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('attempt timed out')), 200);
    await expect(send(transport, `http://127.0.0.1:${port}/`, controller.signal)).rejects.toThrow('attempt timed out');

    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write('.'), 20);
      res.on('close', () => clearInterval(timer));
    };
    const slow = new AbortController();
    setTimeout(() => slow.abort(new Error('slow body')), 200);
    await expect(send(transport, `http://127.0.0.1:${port}/`, slow.signal)).rejects.toThrow('slow body');
  });

  it('gives up during a DNS lookup that hangs', async () => {
    const transport = new HttpWebhookTransport({ lookup: () => new Promise(() => {}) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('dns timed out')), 100);
    await expect(send(transport, 'https://hang.test/', controller.signal)).rejects.toThrow('dns timed out');
  });

  it("adds a private CA to Node's trust store instead of replacing it (node's `ca` option does)", () => {
    // A transport with `ca` for one partner behind a private CA must still deliver to public endpoints.
    const defaults = getCACertificates('default'); // Node's bundle, plus NODE_EXTRA_CA_CERTS
    const trusted = trustedCertificates('-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----');
    expect(trusted.length).toBe(defaults.length + 1);
    expect(trusted.at(-1)).toContain('private');
    expect(trusted[0]).toBe(defaults[0]);
    expect(trustedCertificates([Buffer.from('a'), 'b'])).toHaveLength(defaults.length + 2);
  });

  const openssl = spawnSync('openssl', ['version']).status === 0;
  it.skipIf(!openssl)('pins the address over TLS too: the certificate is verified against the host name, sent as SNI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webhooks-tls-'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        '-subj', '/CN=hooks.partner.test', '-addext', 'subjectAltName=DNS:hooks.partner.test',
      ], { stdio: 'pipe' });
      const cert = readFileSync(join(dir, 'cert.pem'));
      const servernames: (string | undefined)[] = [];
      const tls = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
        servernames.push((req.socket as { servername?: string }).servername);
        req.resume();
        req.on('end', () => res.writeHead(200).end('ok'));
      });
      await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
      const tlsPort = (tls.address() as AddressInfo).port;

      try {
        const dns = resolver(() => [{ address: '127.0.0.1', family: 4 }]);
        const transport = new HttpWebhookTransport({ allowedAddresses: ['127.0.0.1/32'], lookup: dns.lookup, ca: cert });

        const response = await send(transport, `https://hooks.partner.test:${tlsPort}/`);
        expect(response).toMatchObject({ statusCode: 200, body: 'ok' });
        expect(servernames).toEqual(['hooks.partner.test']);
        // Same address, another name: the certificate doesn't cover it.
        await expect(send(transport, `https://evil.test:${tlsPort}/`)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        // Without the CA, an untrusted certificate is refused: there is no option to turn verification off.
        const untrusted = new HttpWebhookTransport({ allowedAddresses: ['127.0.0.1/32'], lookup: dns.lookup });
        await expect(send(untrusted, `https://hooks.partner.test:${tlsPort}/`)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      } finally {
        tls.closeAllConnections();
        await new Promise((resolve) => tls.close(resolve));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
