import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Parse an IPv6 literal into its eight 16-bit groups. Handles `::`
 * compression and a trailing embedded IPv4 dotted quad (e.g. the last
 * group of `::ffff:127.0.0.1`). Returns null for anything that is not a
 * well-formed IPv6 address (zone ids, stray characters, wrong group
 * counts, ...).
 */
function parseIpv6Groups(addr: string): number[] | null {
  const lower = addr.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(lower)) return null;
  const dc = lower.indexOf("::");
  if (dc !== -1 && lower.indexOf("::", dc + 1) !== -1) return null;
  const headPart = dc === -1 ? lower : lower.slice(0, dc);
  const tailPart = dc === -1 ? null : lower.slice(dc + 2);
  const headSegs = headPart === "" ? [] : headPart.split(":");
  const tailSegs =
    tailPart === null || tailPart === "" ? [] : tailPart.split(":");

  const head: number[] = [];
  const tail: number[] = [];
  const pushSeg = (
    seg: string,
    out: number[],
    isFinalSegment: boolean,
  ): boolean => {
    if (seg.includes(".")) {
      // An embedded IPv4 quad is only legal as the very last group pair.
      if (!isFinalSegment || !/^\d{1,3}(\.\d{1,3}){3}$/.test(seg)) return false;
      const octets = seg.split(".").map(Number);
      if (octets.some((n) => n > 255)) return false;
      out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      return true;
    }
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return false;
    out.push(parseInt(seg, 16));
    return true;
  };
  for (let i = 0; i < headSegs.length; i++) {
    const isFinal = tailSegs.length === 0 && i === headSegs.length - 1;
    if (!pushSeg(headSegs[i], head, isFinal)) return null;
  }
  for (let i = 0; i < tailSegs.length; i++) {
    if (!pushSeg(tailSegs[i], tail, i === tailSegs.length - 1)) return null;
  }
  if (dc === -1) {
    return head.length === 8 ? head : null;
  }
  if (head.length + tail.length > 7) return null;
  return [
    ...head,
    ...new Array(8 - head.length - tail.length).fill(0),
    ...tail,
  ];
}

/**
 * N25: canonicalize an IP literal for danger-range classification.
 *
 * `isBlockedAddress` / `classifyAddressRisk` used to run
 * `addr.split(".").map(Number)` on every address, which silently produced
 * NaN for IPv4-mapped IPv6 literals (`::ffff:169.254.169.254`, and the
 * hex form `::ffff:a9fe:a9fe` that WHATWG URL normalization produces for
 * `[::ffff:169.254.169.254]`) — every IPv4 rule missed and the address
 * fell through to the IPv6 branch and was classified "public". A poisoned
 * executor address could therefore point admin-api at the cloud metadata
 * endpoint / loopback / CGNAT through the back door.
 *
 * This helper rewrites such literals back to the embedded dotted-quad IPv4
 * so the existing IPv4 rules apply unchanged:
 *  - `::ffff:0:0/96` (IPv4-mapped, dotted or hex textual form) → embedded IPv4;
 *  - `::/96` (deprecated IPv4-compatible, e.g. `::127.0.0.1` / `::7f00:1`)
 *    → embedded IPv4, EXCEPT `::` and `::1` which stay IPv6 so the
 *    loopback/unspecified handling (and the EXECUTOR_ALLOW_PRIVATE_NETWORK
 *    gate on `::1`) is preserved.
 * Pure IPv6 addresses, IPv4 addresses and non-IP strings are returned
 * untouched. Exported so both classifiers — and tests — share one entry
 * point.
 */
export function normalizeIpForClassification(addr: string): string {
  if (isIP(addr) !== 6) return addr;
  const groups = parseIpv6Groups(addr);
  if (!groups) return addr;
  const highZeros =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0;
  const isMapped = highZeros && groups[5] === 0xffff; // ::ffff:0:0/96
  // ::/96 IPv4-compatible: only rewrite when a real IPv4 is embedded —
  // groups[6] non-zero (hex form like ::7f00:1) or a dotted quad in the
  // text (::127.0.0.1). `::` and `::1` keep their IPv6 semantics.
  const isCompat =
    highZeros && groups[5] === 0 && (groups[6] !== 0 || addr.includes("."));
  if (!isMapped && !isCompat) return addr;
  const v4 = ((groups[6] << 16) | groups[7]) >>> 0;
  return [
    (v4 >>> 24) & 255,
    (v4 >>> 16) & 255,
    (v4 >>> 8) & 255,
    v4 & 255,
  ].join(".");
}

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
        `URL host ${host} is on the deny list (private/loopback/link-local/benchmark/CGNAT)`,
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
  // N25: fold IPv4-mapped / IPv4-compatible IPv6 literals back to their
  // embedded IPv4 so the deny list below actually sees 127.0.0.1 for
  // ::ffff:127.0.0.1 (and the hex form ::ffff:7f00:1) instead of NaN.
  addr = normalizeIpForClassification(addr);
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
  // ::/128, ff00::/8 (multicast). IPv6 ULA is blocked unconditionally — this
  // guard protects webhook/AI targets, where no legitimate use case exists
  // (N32: the previously referenced ALLOW_IPV6_ULA switch never existed).
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
  // N25: same IPv4-mapped/compatible normalization as isBlockedAddress —
  // ::ffff:169.254.169.254 must classify as link-local, not "public".
  addr = normalizeIpForClassification(addr);
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
