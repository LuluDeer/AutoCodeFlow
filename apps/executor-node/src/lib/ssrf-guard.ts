/**
 * E-04（DEEP_REVIEW 0ef3bbe）：SSRF 防护闸——deploy/update-package/download
 * 三条下载链统一调用。execute.ts 原有的内联 privateIpPattern 仅覆盖 RFC1918
 * 点分十进制与 loopback，遗漏云元数据地址 169.254.0.0/16、IPv6 link-local
 * 与十进制/八进制编码 IP。本模块收口为单一 fail-closed 闸：
 *
 * - 默认拒绝 loopback、RFC1918 私网、link-local（含 169.254.169.254 云元数据）、
 *   IPv6 UDA/link-local；
 * - `EXECUTOR_ALLOW_PRIVATE_NETWORK=1` 显式逃生（容器内联调用 admin-api 本机
 *   等合法内网场景需显式选择）；
 * - redirect 链递归调用 downloadFile 时也经过同一闸。
 */

import { config } from '../config';

export interface SsrfGuardOptions {
  /** Skip the private-network check (e.g. tests hitting 127.0.0.1). */
  allowPrivateNetwork?: boolean;
}

/**
 * Parse a hostname (may be a DNS name, IPv4 literal, or IPv6 literal in
 * brackets) and determine whether it resolves to a private/loopback/link-local
 * address. DNS names are checked only for `localhost` and its synonyms;
 * actual DNS resolution is out of scope (the guard is URL-syntax based, not
 * a resolver — a DNS-rebinding attack would require a separate hardening
 * layer which is out of scope for this fix).
 */
function isRestrictedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  // localhost synonyms
  if (host === 'localhost' || host === 'localhost.localdomain') return true;

  // Strip IPv6 brackets if present
  const ipv6 = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;

  // IPv6 loopback / link-local / unique local
  if (host.includes(':')) {
    if (ipv6 === '::1' || ipv6 === '::') return true;
    if (ipv6.startsWith('fe80:') || ipv6.startsWith('fe81:') || ipv6.startsWith('fe82:')) return true;
    if (ipv6.startsWith('fd') || ipv6.startsWith('fc')) return true; // ULA
    // ::ffff:127.x.x.x (IPv4-mapped loopback)
    if (ipv6.startsWith('::ffff:')) {
      const mapped = ipv6.slice(7);
      if (isRestrictedIpv4(mapped)) return true;
    }
    return false;
  }

  // IPv4 checks
  return isRestrictedIpv4(host);
}

function isRestrictedIpv4(ip: string): boolean {
  // Split into octets
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;

  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // RFC1918: 10.0.0.0/8
  if (a === 10) return true;
  // RFC1918: 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // RFC1918: 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 (this network)
  if (a === 0) return true;
  // Carrier-grade NAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Multicast / reserved (224.0.0.0/4, 240.0.0.0/4)
  if (a >= 224) return true;

  return false;
}

/**
 * Validate that an http(s) URL does not target a restricted network address.
 * Throws an Error (fail-closed) when the host is loopback/private/link-local
 * and `allowPrivateNetwork` (or `EXECUTOR_ALLOW_PRIVATE_NETWORK`) is not set.
 */
export function assertSafeHttpUrl(url: string, options: SsrfGuardOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL scheme not allowed: ${parsed.protocol}. Only http and https are permitted.`);
  }

  const allow = options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  if (allow) return;

  const host = parsed.hostname;
  if (isRestrictedHost(host)) {
    throw new Error(
      `URL targets restricted network address: ${host}. ` +
      'Private/loopback/link-local addresses are blocked. ' +
      'Set EXECUTOR_ALLOW_PRIVATE_NETWORK=1 to override (not recommended for production).',
    );
  }
}
