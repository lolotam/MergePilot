import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard for the one URL a workspace may choose: the `custom` provider's base URL
 * (ADR-0010). Only https, never a private / loopback / link-local / CGNAT / unique-local /
 * reserved address. The check runs when the URL is saved AND again on every outbound call
 * (see safe-fetch.ts), where the checked addresses are pinned so DNS rebinding cannot swap
 * them between the check and the connection.
 */
export class SsrFValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrFValidationError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback and IPv4-compatible (deprecated)
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4 address)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local, incl. AWS metadata fd00:ec2::254
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:7f00:1`). */
function mappedIpv4(ip: string): string | undefined {
  // The WHATWG URL parser prints every IPv6 address in one canonical compressed form.
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!match) return undefined;
  const hi = parseInt(match[1] ?? '0', 16);
  const lo = parseInt(match[2] ?? '0', 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** True for any address MergePilot must never send a request (or a key) to. */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const version = isIP(bare);
  if (version === 4) return blockList.check(bare, 'ipv4');
  if (version === 6) {
    let mapped: string | undefined;
    try {
      mapped = mappedIpv4(bare);
    } catch {
      return true;
    }
    if (mapped !== undefined) return blockList.check(mapped, 'ipv4');
    return blockList.check(bare, 'ipv6');
  }
  return true; // not an IP at all: unsafe
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

export const defaultLookup: DnsLookupFn = async (hostname) => {
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family }));
};

/** Parses and checks the URL itself (scheme, credentials, host name); no DNS yet. */
export function parseSafeUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString.trim());
  } catch {
    throw new SsrFValidationError('Invalid URL format');
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrFValidationError(`HTTPS only: protocol "${parsed.protocol}" is not allowed`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrFValidationError('The base URL must not contain a user name or password');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new SsrFValidationError('Base URL missing hostname');
  if (BLOCKED_NAMES.test(hostname)) {
    throw new SsrFValidationError(`Hostname "${hostname}" points to a private or loopback address`);
  }
  return parsed;
}

/**
 * Resolves `hostname` and returns its addresses only when EVERY one is public; a single
 * private answer rejects the host (a mixed answer is a classic rebinding trick).
 */
export async function resolveSafeAddresses(
  hostname: string,
  lookupFn: DnsLookupFn = defaultLookup,
): Promise<ResolvedAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const version = isIP(bare);
  if (version) {
    if (isPrivateIp(bare)) throw new SsrFValidationError(`IP address "${bare}" is private or loopback`);
    return [{ address: bare, family: version }];
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookupFn(bare);
  } catch {
    throw new SsrFValidationError(`Could not resolve hostname "${bare}"`);
  }
  if (addresses.length === 0) throw new SsrFValidationError(`Hostname "${bare}" resolved to no addresses`);
  for (const record of addresses) {
    if (isPrivateIp(record.address)) {
      throw new SsrFValidationError(`Hostname "${bare}" resolves to a private or loopback address`);
    }
  }
  return addresses;
}

/**
 * Validates a base URL (https only, public addresses only) and returns it without trailing
 * slashes. Used when the URL is saved; every call re-checks through the guarded fetch.
 */
export async function assertSafeBaseUrl(urlString: string, lookupFn: DnsLookupFn = defaultLookup): Promise<string> {
  const parsed = parseSafeUrl(urlString);
  await resolveSafeAddresses(parsed.hostname, lookupFn);
  return urlString.trim().replace(/\/+$/, '');
}
