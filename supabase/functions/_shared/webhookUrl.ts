// Delivery policy for agent webhook URLs: public https endpoints only.
// Blocks loopback, private, link-local and cloud-metadata destinations by hostname or IP literal.
// Residual: a public hostname that resolves to a private address (DNS rebinding) is not detected here;
// the dispatcher also refuses to follow redirects, so a redirect cannot steer a delivery inward.

const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal|metadata)$/i;

function ipv4Blocked(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function ipv6Blocked(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('::ffff:')) {
    // IPv4-mapped: the URL parser normalizes `::ffff:10.0.0.1` to `::ffff:a00:1`.
    const rest = h.slice(7);
    if (rest.includes('.')) return ipv4Blocked(rest);
    const [hi, lo] = rest.split(':').map((g) => parseInt(g || '0', 16));
    return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
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
  const host = u.hostname;
  if (!host || BLOCKED_HOST.test(host) || ipv4Blocked(host) || ipv6Blocked(host)) return 'webhook_url_private';
  return null;
}
