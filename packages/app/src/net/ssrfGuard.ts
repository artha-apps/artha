/**
 * ssrfGuard — block the agent from reaching internal/private network targets.
 *
 * Artha's web tools (web_fetch, browser_navigate) take URLs that can originate
 * from an LLM that may be prompt-injected by a hostile page. Without a guard a
 * crafted instruction could make Artha hit loopback services (the local Ollama
 * API, a dev database), the router admin panel, other LAN devices, or a cloud
 * metadata endpoint (169.254.169.254) — classic SSRF.
 *
 * `assertPublicURL` enforces: http(s) only, and the resolved host must be a
 * public address. Hostnames are resolved through DNS and EVERY returned address
 * is checked, so a public name that resolves to a private IP (DNS-rebinding) is
 * still rejected. A user-controlled allowlist (Settings → Web) exists for the
 * deliberate "let the agent talk to my localhost dev server" case.
 *
 * Scope: this is a pragmatic guard for a desktop app, not a hardened proxy. It
 * does not pin the resolved IP through to the socket, so a determined
 * rebinding race is theoretically possible; the cost/benefit for a local,
 * single-user agent doesn't justify a custom-agent HTTP stack here.
 */
import { promises as dns } from 'dns';
import net from 'net';

/** Hostnames that are always internal regardless of DNS. */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata.google.internal'
  );
}

/** True for loopback / private / link-local / unique-local / unspecified IPs
 *  (both IPv4 and IPv6, including IPv4-mapped IPv6 like ::ffff:127.0.0.1). */
export function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateIPv4(ip);
  if (type === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4 address.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return (
      lower === '::1' ||            // loopback
      lower === '::' ||            // unspecified
      lower.startsWith('fe80') ||  // link-local
      lower.startsWith('fc') ||    // unique-local fc00::/7
      lower.startsWith('fd')
    );
  }
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = p;
  return (
    a === 0 ||                              // 0.0.0.0/8 "this host"
    a === 127 ||                            // loopback
    a === 10 ||                             // private
    (a === 172 && b >= 16 && b <= 31) ||    // private
    (a === 192 && b === 168) ||             // private
    (a === 169 && b === 254) ||             // link-local + cloud metadata
    (a === 100 && b >= 64 && b <= 127)      // CGNAT 100.64/10
  );
}

/**
 * Validate that `rawUrl` is a public http(s) URL the agent may fetch/navigate.
 * Throws an Error (with a clear, user-facing message) when it isn't. Hosts in
 * `allowHosts` (case-insensitive exact host match) bypass the private-IP block,
 * for users who intentionally point the agent at a local service.
 */
export async function assertPublicURL(rawUrl: string, allowHosts: string[] = []): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Blocked: "${rawUrl}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: only http(s) URLs are allowed (got ${parsed.protocol}).`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const allowed = allowHosts.map(h => h.toLowerCase());
  if (allowed.includes(host.toLowerCase())) return parsed;

  if (isBlockedHostname(host)) {
    throw new Error(`Blocked: "${host}" is an internal host. Add it to Settings → Web → allowed local hosts to permit it.`);
  }

  // Literal IP — check directly. Hostname — resolve and check every address.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked: "${host}" is a private/loopback address (SSRF protection).`);
    return parsed;
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Blocked: could not resolve "${host}".`);
  }
  if (addrs.length === 0) throw new Error(`Blocked: "${host}" did not resolve to any address.`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error(`Blocked: "${host}" resolves to a private/loopback address (${address}) — SSRF protection.`);
    }
  }
  return parsed;
}
