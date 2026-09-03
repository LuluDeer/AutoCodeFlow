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
    // V3 (round-7): RFC 2544 benchmarking range — commonly occupied by TUN
    // interfaces (e.g. proxy/VPN clients), so it behaves like a local
    // listener and must not slip past the notification/AI SSRF guard.
    if (v[0] === 198 && (v[1] === 18 || v[1] === 19)) return true; // 198.18.0.0/15
    // V3 (round-7): RFC 6598 CGNAT range — used by Tailscale/carrier NAT to
    // reach private hosts; same deny semantics as loopback/RFC1918.
    if (v[0] === 100 && v[1] >= 64 && v[1] <= 127) return true; // 100.64.0.0/10
    if (v[0] >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6: block loopback ::1, fc00::/7 (unique local), fe80::/10 (link-local),
  // ::/128, ff00::/8 (multicast). Allow IPv6 ULA only when ALLOW_IPV6_ULA=true.
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return true;
  if (lower.startsWith("ff")) return true;
  return false;
}

/**
 * How risky a resolved IP is as an OUTBOUND TARGET for executor-bound traffic.
 *
 * Executors legitimately live on private networks (docker-compose puts them on
 * the `autoflow-internal` bridge — 172.16/12 — and LAN installs register
 * 10.x/192.168.x addresses), so the blanket RFC1918 deny list used for
 * webhook/AI targets cannot be applied to executor addresses by default.
 * The categories below let the executor policy always block the truly
 * dangerous ranges (link-local/cloud metadata, unspecified, multicast) while
 * keeping private-LAN targets reachable.
 */
type AddressRisk =
  | "public"
  | "private-lan"
  | "loopback"
  | "link-local"
  | "restricted"
  | "reserved";

function classifyAddressRisk(addr: string): AddressRisk | null {
  if (!isIP(addr)) return null;
  const v = addr.split(".").map(Number);
  if (v.length === 4) {
    if (v[0] === 127) return "loopback"; // 127.0.0.0/8
    if (v[0] === 169 && v[1] === 254) return "link-local"; // incl. AWS/GCP metadata 169.254.169.254
    if (v[0] === 0) return "reserved"; // this-network / unspecified
    if (v[0] >= 224) return "reserved"; // multicast / reserved
    // V3 (round-7): benchmarking (RFC 2544) and CGNAT (RFC 6598) are blocked
    // for webhook/AI targets outright; for executor traffic they follow the
    // same gated semantics as loopback — refused by default, allowed only
    // with EXECUTOR_ALLOW_PRIVATE_NETWORK=true (Tailscale-style overlays).
    if (v[0] === 198 && (v[1] === 18 || v[1] === 19)) return "restricted"; // 198.18.0.0/15
    if (v[0] === 100 && v[1] >= 64 && v[1] <= 127) return "restricted"; // 100.64.0.0/10
    if (v[0] === 10) return "private-lan"; // 10.0.0.0/8
    if (v[0] === 172 && v[1] >= 16 && v[1] <= 31) return "private-lan"; // 172.16/12
    if (v[0] === 192 && v[1] === 168) return "private-lan"; // 192.168/16
    return "public";
  }
  const lower = addr.toLowerCase();
  if (lower === "::1") return "loopback";
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return "link-local"; // fe80::/10
  }
  if (lower === "::" || lower.startsWith("ff")) return "reserved"; // unspecified / multicast
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "private-lan"; // fc00::/7 unique local
  return "public";
}

/**
 * F-3: SSRF guard for outbound requests whose target is an EXECUTOR address
 * (registered via /api/executors/register or carried in deployment rows).
 *
 * Policy (differs from assertSafeHttpUrl on purpose):
 *  - ALWAYS blocked: link-local / cloud-metadata (169.254.169.254 is the
 *    classic credential-exfiltration target), unspecified (0.0.0.0, ::),
 *    multicast/reserved, and any non-http(s) protocol.
 *  - Loopback (127.0.0.1, ::1) is blocked unless EXECUTOR_ALLOW_PRIVATE_NETWORK=true
 *    (same-host dev deployments where the executor runs next to admin-api).
 *  - Restricted ranges — 198.18.0.0/15 (RFC 2544 benchmarking, commonly taken by
 *    TUN interfaces) and 100.64.0.0/10 (RFC 6598 CGNAT, Tailscale overlays) —
 *    follow the loopback rule (V3): blocked by default, allowed only with
 *    EXECUTOR_ALLOW_PRIVATE_NETWORK=true. assertSafeHttpUrl blocks them outright.
 *  - Private LAN ranges (10/8, 172.16/12, 192.168/16, IPv6 ULA) are ALLOWED by
 *    default: the documented deployment topology runs admin-api and executors
 *    on the same internal network, so the webhook/AI blanket RFC1918 block
 *    would break every standard install. Set EXECUTOR_ALLOW_PRIVATE_NETWORK=true
 *    only for same-host/dev setups that additionally need loopback reachability.
 *
 * Throws BadRequestException when the target must not be contacted.
 */
export async function assertSafeExecutorUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`Invalid executor URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestException(
      `Executor URL must use http(s); got '${url.protocol}'`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BadRequestException("Executor URL missing hostname");
  // Credentials in the URL would end up in logs/error reports — reject them.
  if (url.username || url.password) {
    throw new BadRequestException("Executor URL must not embed credentials");
  }

  const allowPrivateNetwork =
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK === "true";

  const check = (addr: string) => {
    const risk = classifyAddressRisk(addr);
    if (risk === "public" || risk === "private-lan") return;
    // V3 (round-7): "restricted" (benchmark/CGNAT) follows the loopback rule —
    // refused by default, reachable only under EXECUTOR_ALLOW_PRIVATE_NETWORK.
    if ((risk === "loopback" || risk === "restricted") && allowPrivateNetwork)
      return;
    throw new BadRequestException(
      `Executor address ${host} resolves to ${addr} (${risk}) — outbound request refused`,
    );
  };

  if (isIP(host)) {
    check(host);
    return url;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new BadRequestException(
      `Failed to resolve executor host ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addrs.length === 0) {
    throw new BadRequestException(`Executor host ${host} did not resolve`);
  }
  for (const a of addrs) {
    check(a.address);
  }
  return url;
}
