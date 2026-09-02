import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Reject hosts that resolve to private / loopback / link-local / cloud-metadata
 * addresses. Returns the canonical URL when safe; throws BadRequest otherwise.
 *
 * This is the single chokepoint for all outbound HTTP triggered by admin
 * configuration: webhook channels (NOTIF-001), AI providers (AI-001), and
 * anything else we add later. Centralizing the check prevents one-off
 * regressions.
 */
export async function assertSafeHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestException(
      `URL must use http(s); got '${url.protocol}'`,
    );
  }
  const host = url.hostname;
  if (!host) throw new BadRequestException("URL missing hostname");

  // If the host is an IP literal we can decide synchronously.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BadRequestException(
        `URL host ${host} is on the deny list (private/loopback/link-local)`,
      );
    }
    return url;
  }
  // Hostname: resolve via DNS and check every answer.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new BadRequestException(
      `Failed to resolve URL host ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addrs.length === 0) {
    throw new BadRequestException(`URL host ${host} did not resolve`);
  }
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new BadRequestException(
        `URL host ${host} resolves to a blocked address (${a.address})`,
      );
    }
  }
  return url;
}

function isBlockedAddress(addr: string): boolean {
  if (!isIP(addr)) return false;
  const v = addr.split(".").map(Number);
  if (v.length === 4) {
    // IPv4 ranges
    if (v[0] === 10) return true; // 10.0.0.0/8
    if (v[0] === 127) return true; // 127.0.0.0/8 loopback
    if (v[0] === 172 && v[1] >= 16 && v[1] <= 31) return true; // 172.16/12
    if (v[0] === 192 && v[1] === 168) return true; // 192.168/16
    if (v[0] === 169 && v[1] === 254) return true; // link-local incl. AWS metadata 169.254.169.254
    if (v[0] === 0) return true;
    if (v[0] >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6: block loopback ::1, fc00::/7 (unique local), fe80::/10 (link-local),
  // ::/128, ff00::/8 (multicast). Allow IPv6 ULA only when ALLOW_IPV6_ULA=true.
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("ff")) return true;
  return false;
}