// Delivery policy for agent webhook URLs: public https endpoints only.
// `webhookUrlError` vets the URL as written (scheme, credentials, hostname, IP literal); `isBlockedIp` vets the
// addresses the hostname resolves to at delivery time. Both reject loopback, private, link-local, documentation,
// multicast and cloud-metadata destinations, including IPv4 addresses embedded in IPv6 forms.
// Residual: an address that changes between resolution and connect (DNS rebinding) is not detected; the
// dispatcher also refuses to follow redirects, so a redirect cannot steer a delivery inward.

const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal|metadata)$/;

/** Hostname as the policy compares it: lowercase, no trailing dots, no IPv6 brackets. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
}

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function ipv4OctetsBlocked([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 // this network, private, loopback
    || (a === 100 && b >= 64 && b <= 127) // shared address space 100.64/10
    || (a === 169 && b === 254) // link-local and cloud metadata
    || (a === 172 && b >= 16 && b <= 31) // private 172.16/12
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol assignments, TEST-NET-1
    || (a === 192 && b === 168) // private
    || (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18/15
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // TEST-NET-2/3
    || a >= 224; // multicast, reserved, broadcast
}

/** Parses an IPv6 literal (with optional embedded dotted IPv4) into eight 16-bit groups. */
function parseIpv6(s: string): number[] | null {
  let text = s;
  const v4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (v4) {
    const o = parseIpv4(v4[1]);
    if (!o) return null;
    text = `${text.slice(0, v4.index)}:${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
}

function ipv6GroupsBlocked(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => ipv4OctetsBlocked([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroThrough(6)) return true; // ::/96: unspecified, loopback, IPv4-compatible (deprecated): never public
  if (zeroThrough(5) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:0:0/96 IPv4-mapped
  if (zeroThrough(4) && g[4] === 0xffff && g[5] === 0) return embedded(g[6], g[7]); // ::ffff:0:0:0/96 IPv4-translated
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return embedded(g[6], g[7]); // 64:ff9b:1::/48 local NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: embedded addresses are not vetted
  return false;
}

/** True when the IP literal (v4 or v6, brackets allowed) must not be a delivery destination. */
export function isBlockedIp(ip: string): boolean {
  const h = normalizeHost(ip);
  const v4 = parseIpv4(h);
  if (v4) return ipv4OctetsBlocked(v4);
  const v6 = parseIpv6(h);
  if (v6) return ipv6GroupsBlocked(v6);
  return true; // not an address we can vet
}

/** True when the string is an IP literal rather than a name. */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host);
  return parseIpv4(h) !== null || parseIpv6(h) !== null;
}

/** Returns null when the URL may be called, otherwise a short error code. */
export function webhookUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'webhook_url_invalid';
  }
  if (u.protocol !== 'https:') return 'webhook_url_not_https';
  if (u.username || u.password) return 'webhook_url_has_credentials';
  const host = normalizeHost(u.hostname);
  if (!host || BLOCKED_HOST.test(host)) return 'webhook_url_private';
  if (isIpLiteral(host) && isBlockedIp(host)) return 'webhook_url_private';
  return null;
}
