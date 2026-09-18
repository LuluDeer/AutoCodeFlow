/**
 * E-04（DEEP_REVIEW 0ef3bbe）：SSRF 防护闸——deploy/update-package/download
 * 三条下载链统一调用。execute.ts 原有的内联 privateIpPattern 仅覆盖 RFC1918
 * 点分十进制与 loopback，遗漏云元数据地址 169.254.0.0/16、IPv6 link-local
 * 与十进制/八进制编码 IP。本模块收口为单一 fail-closed 闸：
 *
 * - 默认拒绝 loopback、RFC1918 私网、link-local（含 169.254.169.254 云元数据）、
 *   IPv6 UDA/link-local；
 * - `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（`1` 亦兼容）显式逃生（容器内联调用 admin-api 本机
 *   等合法内网场景需显式选择）；
 * - redirect 链递归调用 downloadFile 时也经过同一闸。
 */

import { config } from '../config';
import * as dns from 'node:dns';

export interface SsrfGuardOptions {
  /** Skip the private-network check (e.g. tests hitting 127.0.0.1). */
  allowPrivateNetwork?: boolean;
}

/**
 * IPv6 受限地址判定（loopback / link-local / ULA / IPv4-mapped 受限）。
 * 与 isRestrictedHost 的 IPv6 分支共享——DNS 复核也用它判 AAAA 记录。
 */
function isRestrictedIpv6Address(ipv6Raw: string): boolean {
  const ipv6 = ipv6Raw.toLowerCase();
  if (ipv6 === '::1' || ipv6 === '::') return true;
  if (ipv6.startsWith('fe80:') || ipv6.startsWith('fe81:') || ipv6.startsWith('fe82:')) return true;
  if (ipv6.startsWith('fd') || ipv6.startsWith('fc')) return true; // ULA
  // ::ffff:127.x.x.x (IPv4-mapped loopback / 其它 IPv4 受限地址)
  if (ipv6.startsWith('::ffff:')) {
    return isRestrictedIpv4(ipv6.slice(7));
  }
  return false;
}

/**
 * Parse a hostname (may be a DNS name, IPv4 literal, or IPv6 literal in
 * brackets) and determine whether it resolves to a private/loopback/link-local
 * address. DNS names are checked only for `localhost` and its synonyms;
 * actual DNS resolution lives in `assertSafeDnsResolution` (S-1) — this
 * function is URL-syntax based.
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
    return isRestrictedIpv6Address(ipv6);
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
      'Set EXECUTOR_ALLOW_PRIVATE_NETWORK=true (or 1) to override (not recommended for production).',
    );
  }
}

/**
 * S-1（audit-r4）：DNS rebinding 加固——把「URL 语法级闸」（assertSafeHttpUrl）
 * 升级为「解析后 IP 级闸」。语法级检查只认字面 IP 与 localhost；攻击者注册的
 * 域名第一次解析返回公网 IP 通过语法闸、连接时二次解析返回内网 IP，即可绕过
 * 字面检查。本函数在**发起连接前**解析主机名，对解析出的**每一个** A/AAAA
 * 地址逐一过受限判定，任一受限即 fail-closed；解析失败同样拒绝（无法证明目标
 * 安全就不连，与闸的 fail-closed 纪律一致）。
 *
 * 残余风险（如实文档化）：resolve-then-connect 之间仍有 TOCTOU 窗口（Node
 * fetch/http 不暴露连接级 IP 钉扎）。这是防护层的收窄而非消灭；生产加固建议
 * 在容器/网络层叠加 egress 策略（与 executor-python 的
 * _assert_url_host_not_restricted 同级别）。
 */
export async function assertSafeDnsResolution(
  url: string,
  options: SsrfGuardOptions = {},
): Promise<void> {
  const allow = options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  if (allow) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // 独立调用时的纵深防御：download 链路上游已过 assertSafeHttpUrl，
    // 但本函数不应在未校验 scheme 的情况下对任意协议发起解析。
    throw new Error(`URL scheme not allowed: ${parsed.protocol}. Only http and https are permitted.`);
  }
  const host = parsed.hostname;
  // 字面 IP / localhost 同义词：语法级闸已覆盖，无需（也无法再）解析。
  if (host === 'localhost' || host === 'localhost.localdomain') return;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return;

  let addresses: Array<{ address: string; family: number }>;
  try {
    // dns.promises.lookup 的 all:true 重载返回 LookupAddress[]、all:false 返回
    // LookupAddress——union 在 Array.isArray 收窄时会被推成 never，这里显式
    // 声明并收窄到稳定的「{address,family}」形状。
    const result: unknown = await dns.promises.lookup(host, { all: true, verbatim: true });
    addresses = Array.isArray(result)
      ? (result as Array<{ address: string; family: number }>)
      : [{ address: (result as { address: string; family: number }).address, family: (result as { address: string; family: number }).family }];
  } catch {
    // 解析失败 = 无法证明安全：fail-closed，绝不带病连接。
    throw new Error(
      `URL host ${host} failed DNS resolution; refusing connection (SSRF guard)`,
    );
  }
  for (const { address } of addresses) {
    const restricted = address.includes(':')
      ? isRestrictedIpv6Address(address)
      : isRestrictedIpv4(address);
    if (restricted) {
      throw new Error(
        `URL host ${host} resolves to restricted network address ${address}; ` +
          'possible DNS rebinding. Private/loopback/link-local addresses are blocked. ' +
          'Set EXECUTOR_ALLOW_PRIVATE_NETWORK=true (or 1) to override (not recommended for production).',
      );
    }
  }
}
