import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrFValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrFValidationError';
  }
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed IPv4 considered unsafe
  }
  const [b0, b1] = parts as [number, number, number, number];

  // 0.0.0.0/8
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;
  // 169.254.0.0/16 (Link-local)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;
  // 100.64.0.0/10 (Carrier Grade NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (b0 >= 224) return true;

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // IPv4-mapped IPv6: ::ffff:192.0.2.128
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (isIP(v4) === 4) {
      return isPrivateIpv4(v4);
    }
  }

  // Loopback (::1 or 0:...:1)
  if (normalized === '::1' || /^0*(:0*)*:1$/.test(normalized)) {
    return true;
  }

  // Unspecified (::)
  if (normalized === '::' || /^0*(:0*)*$/.test(normalized)) {
    return true;
  }

  // Unique local addresses (fc00::/7) -> fc.. or fd..
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // Link-local unicast (fe80::/10) -> fe8, fe9, fea, feb
  if (/^fe[89ab]/i.test(normalized)) {
    return true;
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith('ff')) {
    return true;
  }

  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  // If not recognized as standard IP, treat as unsafe
  return true;
}

const defaultLookup: DnsLookupFn = async (hostname: string) => {
  const res = await dnsLookup(hostname, { all: true });
  return Array.isArray(res) ? res : [res];
};

/**
 * Validates that a base URL uses HTTPS and does not resolve to private,
 * loopback, or link-local IP addresses (SSRF guard). Returns the cleaned URL.
 */
export async function assertSafeBaseUrl(
  urlString: string,
  lookupFn: DnsLookupFn = defaultLookup,
): Promise<string> {
  const trimmed = urlString.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrFValidationError('Invalid URL format');
  }

  if (parsed.protocol !== 'https:') {
    throw new SsrFValidationError(`HTTPS only: protocol "${parsed.protocol}" is not allowed`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new SsrFValidationError('Base URL missing hostname');
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new SsrFValidationError(`Hostname "${hostname}" points to a private or loopback address`);
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrFValidationError(`IP address "${hostname}" is private or loopback`);
    }
  } else {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookupFn(hostname);
    } catch {
      throw new SsrFValidationError(`Could not resolve hostname "${hostname}"`);
    }

    if (!addresses || addresses.length === 0) {
      throw new SsrFValidationError(`Hostname "${hostname}" resolved to no addresses`);
    }

    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        throw new SsrFValidationError(
          `Hostname "${hostname}" resolves to private or loopback IP: ${record.address}`,
        );
      }
    }
  }

  return trimmed.replace(/\/+$/, '');
}
