import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
// tsconfig 未开 esModuleInterop（仅 allowSyntheticDefaultImports）——默认导入在
// CJS 下会取 `.default`（undefined）。必须用命名空间导入才能拿到真实模块。
import * as http from "node:http";
import * as https from "node:https";
// ARCH-27: 本文件是无 DI 的纯工具函数，无法注入 ConfigService —— env 读取
// 统一经 src/config/env.ts 收口（全仓唯一直读通道）。
import { getEnvVar } from "../../config/env";

/**
 * F-3 (SEC-NEW): the result of validating + DNS-pinning an outbound URL.
 *
 * `url` is the ORIGINAL URL — it is never rewritten, so Host header, TLS SNI
 * and virtual-host routing stay correct by construction. The pinning happens
 * at the socket layer: `pinnedAxiosConfig` returns an http(s).Agent whose
 * `lookup` always answers the validated `pinnedIp`, so TCP/TLS connects to
 * exactly the address that passed the deny table, even if the hostname's DNS
 * rebinds afterwards (closing the DNS-rebinding window the plain guards
 * document as a follow-up). `pinned` is false when the host was already an
 * IP literal (nothing to pin, no custom agent needed).
 */
export interface PinnedHttpTarget {
  url: URL;
  pinnedIp: string;
  pinned: boolean;
}

/**
 * F-3 (SEC-NEW): DNS-rebinding-safe outbound target for axios call sites.
 *
 * One call replaces the `assertSafeHttpUrl/assertSafeExecutorUrl` +
 * `axios.*(url, ...)` pair: it parses → classifies every DNS answer against
 * the unified deny table → returns a target pinned to the first validated
 * IP. The call site keeps using the ORIGINAL url string and spreads
 * `pinnedAxiosConfig(target)` into its axios options — the returned agent
 * answers DNS with the validated IP, so re-resolution can never happen.
 *
 * Policy mirrors the existing guards exactly:
 *  - `policy: "executor"` → assertSafeExecutorUrl posture (private-lan
 *    allowed by default; loopback/restricted gated by EXECUTOR_ALLOW_PRIVATE_NETWORK);
 *  - `policy: "webhook"` (default) → assertSafeHttpUrl posture (only public
 *    by default; private-lan/loopback/restricted gated by `allowPrivateNetwork`).
 *
 * Redirects stay refused by the call sites (`maxRedirects: 0` — R3); the
 * pinned first hop is the only hop.
 */
export async function assertAndPinHttpUrl(
  rawUrl: string,
  opts: {
    allowPrivateNetwork?: boolean;
    policy?: "webhook" | "executor";
  } = {},
): Promise<PinnedHttpTarget> {
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
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BadRequestException("URL missing hostname");
  if (url.username || url.password) {
    // B-2: credentials in the URL would leak through logs/error reports.
    throw new BadRequestException(
      `URL must not embed credentials: ${stripUserinfo(rawUrl)}`,
    );
  }

  const isExecutor = opts.policy === "executor";
  const allowPrivateNetwork =
    opts.allowPrivateNetwork ??
    (isExecutor
      ? getEnvVar("EXECUTOR_ALLOW_PRIVATE_NETWORK") === "true"
      : false);

  // assertSafeHttpUrl posture: only public by default; private-lan/loopback/
  // restricted unlocked by the flag; link-local + reserved always refused.
  const allowedWebhook = (risk: AddressRisk | null): boolean =>
    risk === "public" ||
    (allowPrivateNetwork &&
      (risk === "private-lan" || risk === "loopback" || risk === "restricted"));
  // assertSafeExecutorUrl posture: private-lan always; loopback/restricted
  // under the flag; link-local + reserved always refused.
  const allowedExecutor = (risk: AddressRisk | null): boolean =>
    risk === "public" ||
    risk === "private-lan" ||
    (allowPrivateNetwork && (risk === "loopback" || risk === "restricted"));
  const allowedRisk = isExecutor ? allowedExecutor : allowedWebhook;

  const pick = (addrs: string[]): string => {
    // All answers passed the deny table; pin to a stable one. Prefer an IPv4
    // answer when one exists: dual-stack hosts (e.g. `localhost` → ::1 +
    // 127.0.0.1) routinely run their service on IPv4 loopback only, and
    // pinning the first (IPv6) answer makes the socket connect fail with
    // ECONNREFUSED. IPv6-only deployments still work — they simply have no
    // IPv4 answer to prefer.
    const v4 = addrs.find((a) => isIP(a) === 4);
    const addr = v4 ?? addrs[0];
    if (!addr) {
      throw new BadRequestException(`URL host ${host} did not resolve`);
    }
    return addr;
  };

  if (isIP(host)) {
    if (!allowedRisk(classifyAddressRisk(host))) {
      throw new BadRequestException(
        `URL host ${host} is on the deny list (private/loopback/link-local/benchmark/CGNAT) — outbound request refused`,
      );
    }
    return { url, pinnedIp: host, pinned: false };
  }

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
  const allowed: string[] = [];
  for (const a of addrs) {
    const risk = classifyAddressRisk(a.address);
    if (!allowedRisk(risk)) {
      throw new BadRequestException(
        `URL host ${host} resolves to a blocked address (${a.address}) — outbound request refused`,
      );
    }
    allowed.push(a.address);
  }

  return {
    url,
    pinnedIp: pick(allowed),
    pinned: true,
  };
}

/**
 * F-3 (SEC-NEW): executor-posture shortcut for
 * `assertAndPinHttpUrl(url, { policy: "executor" })` — replaces the
 * `assertSafeExecutorUrl` + axios pairs at executor dispatch/kill/package
 * call sites with one pinned request path.
 */
export async function assertAndPinExecutorUrl(
  rawUrl: string,
): Promise<PinnedHttpTarget> {
  return assertAndPinHttpUrl(rawUrl, { policy: "executor" });
}

/**
 * F-3 (SEC-NEW): axios config fragment for a pinned target — an http(s)
 * agent whose `lookup` always answers the validated IP, so the TCP/TLS
 * connection can never re-resolve (DNS rebinding closed). The original URL
 * (Host header / TLS SNI / virtual host) is untouched by construction.
 * Defensive on `target === undefined`/`null` and `pinned === false`: returns
 * `{}` so a stubbed guard in a spec (automock) degrades to the plain URL.
 */
export function pinnedAxiosConfig(target?: PinnedHttpTarget | null): {
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent;
} {
  if (!target || !target.pinned) return {};
  const pinnedIp = target.pinnedIp;
  const family = isIP(pinnedIp) === 6 ? 6 : 4;
  // Node's http(s).Agent calls lookup(hostname, options, cb) per new socket;
  // always answer with the validated address. Node ≥ 22 passes `{all:true}`
  // (hints:0) to the custom lookup, and its lookupAndConnect expects the
  // ARRAY shape `(null, [{address, family}])` in that case — a bare
  // `(null, ip, family)` makes Node take `result[0].address` of the string,
  // i.e. `undefined`, and socket creation fails with
  // "Invalid IP address: undefined". Older consumers may pass `all:false`/
  // omit `all`, where the scalar shape `(null, ip, family)` is expected, so
  // honor both shapes based on `options.all` (checked defensively: `all`
  // falsy or undefined → scalar; explicit `all:true` → array).
  const pinnedLookup: http.AgentOptions["lookup"] = (
    _hostname,
    options,
    cb,
  ) => {
    const opts = (options ?? {}) as { all?: boolean };
    if (opts.all === true) {
      cb(null, [{ address: pinnedIp, family }]);
      return;
    }
    cb(null, pinnedIp, family);
  };
  return target.url.protocol === "https:"
    ? { httpsAgent: new https.Agent({ lookup: pinnedLookup }) }
    : { httpAgent: new http.Agent({ lookup: pinnedLookup }) };
}

/**
 * B-2: mask userinfo in a URL before it ever reaches a log line / error
 * message. A rejected URL must not echo the very credential it carried
 * (the rejection itself would leak it). `https://user:pass@host/x` →
 * `https://[redacted]@host/x`; anything without userinfo is returned
 * unchanged.
 */
export function stripUserinfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    const hostPart = url.host; // includes port
    url.username = "";
    url.password = "";
    return `${url.protocol}//[redacted]@${hostPart}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "[redacted]";
  }
}

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
 * The pre-N25 classifiers ran `addr.split(".").map(Number)` on every
 * address, which silently produced
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
 *
 * SEC-04: the deny set is the unified SSRF_DENY_HOST_PATTERNS table via
 * classifyAddressRisk ("deny every non-public class" posture).
 *
 * AUTH/ARCH-31（2026-09-13）：可选 `opts.allowPrivateNetwork` 放开内网目标，
 * 语义镜像 assertSafeExecutorUrl 的 EXECUTOR_ALLOW_PRIVATE_NETWORK 姿态：
 *  - 恒拒：link-local（169.254.169.254 云元数据在段内——凭据外泄经典目标）、
 *    reserved/unspecified；
 *  - 开关开启才放行：loopback（127.0.0.1/::1，同机自建服务如本地 Ollama）、
 *    restricted（198.18/15 benchmark 与 100.64/10 CGNAT/Tailscale）、
 *    private-lan（10/8、172.16/12、192.168/16、IPv6 ULA）。
 * 缺省（不传 opts）行为与既往逐字节一致：除 public 外全拒。
 * 开关由调用方从 ConfigService 读取传入（本函数保持无 DI 纯函数形态，
 * env 直读收口在 src/config/env.ts）。
 */
export async function assertSafeHttpUrl(
  rawUrl: string,
  opts?: { allowPrivateNetwork?: boolean },
): Promise<URL> {
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
  // SEC-04: strip the WHATWG IPv6 brackets (url.hostname keeps "[::1]") so
  // IPv6 literals reach the unified classifier exactly like the executor/git
  // guards do. Previously bracketed literals fell into the DNS path below
  // and were only refused incidentally — and platform-dependently
  // (Linux getaddrinfo rejects "[::1]", Windows accepts it).
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BadRequestException("URL missing hostname");

  const allowPrivateNetwork = opts?.allowPrivateNetwork === true;

  // 默认姿态（SEC-04）：除 public 全拒。开关开启时镜像 assertSafeExecutorUrl
  // 姿态：loopback/restricted/private-lan 放行，link-local（云元数据）与
  // reserved 恒拒。报错文案保持默认路径历史措辞（既有 spec 逐字匹配）。
  const allowedRisk = (risk: AddressRisk | null): boolean =>
    risk === "public" ||
    (allowPrivateNetwork &&
      (risk === "private-lan" || risk === "loopback" || risk === "restricted"));

  // If the host is an IP literal we can decide synchronously.
  if (isIP(host)) {
    if (!allowedRisk(classifyAddressRisk(host))) {
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
    if (!allowedRisk(classifyAddressRisk(a.address))) {
      throw new BadRequestException(
        `URL host ${host} resolves to a blocked address (${a.address})`,
      );
    }
  }
  return url;
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
 *
 * SEC-04: the category assignment is no longer hand-rolled per guard — every
 * category is derived from the single segment table `SSRF_DENY_HOST_PATTERNS`
 * below, which is the union of the deny lists the three guards used to
 * maintain separately (webhook/AI, executor, git).
 */
export type AddressRisk =
  | "public"
  | "private-lan"
  | "loopback"
  | "link-local"
  | "restricted"
  | "reserved";

/** Every non-public risk class carried by the unified deny table. */
export type SsrfDenyRisk = Exclude<AddressRisk, "public">;

interface SsrfDenySegmentBase {
  /** Stable identifier, e.g. "ipv4-cgnat" — referenced by tests and docs. */
  readonly id: string;
  /** CIDR notation of the covered range (documentation/tests). */
  readonly cidr: string;
  /** Risk class assigned to matching addresses. */
  readonly risk: SsrfDenyRisk;
}

export interface SsrfDenySegmentIpv4 extends SsrfDenySegmentBase {
  /** `octets` = the four dotted-quad numbers of the (normalized) address. */
  readonly matches: (octets: readonly number[]) => boolean;
}

export interface SsrfDenySegmentIpv6 extends SsrfDenySegmentBase {
  /** `groups` = the eight 16-bit groups of the (normalized) address. */
  readonly matches: (groups: readonly number[]) => boolean;
}

/**
 * SEC-04 — SINGLE SOURCE OF TRUTH for SSRF danger ranges; the authoritative
 * location for docs/observability references to the deny list.
 *
 * One table backs all three guards (`assertSafeHttpUrl` for webhook/AI,
 * `assertSafeExecutorUrl` for executor traffic, `assertSafeGitRepoUrl` for
 * git clones). It is the exact union of the deny lists those guards used to
 * maintain separately — no segment was removed, so no existing protection is
 * narrowed:
 *  - IPv4: unspecified 0/8, RFC1918 10/8 + 172.16/12 + 192.168/16, CGNAT
 *    100.64/10 (RFC 6598), loopback 127/8, link-local 169.254/16 (incl. the
 *    169.254.169.254 cloud-metadata endpoint), benchmarking 198.18/15
 *    (RFC 2544), multicast 224/4 and reserved 240/4 (the old `>= 224` rule,
 *    split into its two RFC ranges).
 *  - IPv6: unspecified ::/128, loopback ::1/128, unique-local fc00::/7,
 *    link-local fe80::/10, multicast ff00::/8. IPv4-mapped / IPv4-compatible
 *    literals (`::ffff:127.0.0.1`, dotted or hex forms) are folded to their
 *    embedded IPv4 by normalizeIpForClassification BEFORE this table runs.
 *
 * The matchers compare the PARSED octets/groups, not string prefixes — this
 * closes a classifier gap where full-form IPv6 text (`0:0:0:0:0:0:0:1`) was
 * treated as public even though it is ::1.
 *
 * Guard postures on top of this table (thin wrappers, see below):
 *  - assertSafeHttpUrl (webhook/AI): denies EVERY non-public class.
 *  - assertSafeExecutorUrl: also allows private-lan; loopback + restricted
 *    gated by EXECUTOR_ALLOW_PRIVATE_NETWORK.
 *  - assertSafeGitRepoUrl: allows public + IPv4 private-lan only (IPv6 ULA
 *    denied, N32 posture).
 *
 * Metadata HOSTNAMES (e.g. metadata.google.internal) need no name list: they
 * resolve into 169.254.0.0/16 and are denied at the IP level, which is
 * strictly stronger than name matching.
 */
const IPV4_DENY_SEGMENTS: readonly SsrfDenySegmentIpv4[] = [
  {
    id: "ipv4-unspecified",
    cidr: "0.0.0.0/8",
    risk: "reserved",
    matches: (v) => v[0] === 0,
  },
  {
    id: "ipv4-rfc1918-10",
    cidr: "10.0.0.0/8",
    risk: "private-lan",
    matches: (v) => v[0] === 10,
  },
  {
    id: "ipv4-cgnat",
    cidr: "100.64.0.0/10",
    risk: "restricted",
    matches: (v) => v[0] === 100 && v[1] >= 64 && v[1] <= 127,
  },
  {
    id: "ipv4-loopback",
    cidr: "127.0.0.0/8",
    risk: "loopback",
    matches: (v) => v[0] === 127,
  },
  {
    id: "ipv4-link-local-metadata",
    cidr: "169.254.0.0/16",
    risk: "link-local",
    matches: (v) => v[0] === 169 && v[1] === 254,
  },
  {
    id: "ipv4-rfc1918-172",
    cidr: "172.16.0.0/12",
    risk: "private-lan",
    matches: (v) => v[0] === 172 && v[1] >= 16 && v[1] <= 31,
  },
  {
    id: "ipv4-rfc1918-192",
    cidr: "192.168.0.0/16",
    risk: "private-lan",
    matches: (v) => v[0] === 192 && v[1] === 168,
  },
  {
    id: "ipv4-benchmark",
    cidr: "198.18.0.0/15",
    risk: "restricted",
    matches: (v) => v[0] === 198 && (v[1] === 18 || v[1] === 19),
  },
  {
    id: "ipv4-multicast",
    cidr: "224.0.0.0/4",
    risk: "reserved",
    matches: (v) => v[0] >= 224 && v[0] <= 239,
  },
  {
    id: "ipv4-reserved",
    cidr: "240.0.0.0/4",
    risk: "reserved",
    matches: (v) => v[0] >= 240,
  },
];

const IPV6_DENY_SEGMENTS: readonly SsrfDenySegmentIpv6[] = [
  {
    id: "ipv6-unspecified",
    cidr: "::/128",
    risk: "reserved",
    matches: (g) => g.every((group) => group === 0),
  },
  {
    id: "ipv6-loopback",
    cidr: "::1/128",
    risk: "loopback",
    matches: (g) => g.slice(0, 7).every((group) => group === 0) && g[7] === 1,
  },
  {
    id: "ipv6-unique-local",
    cidr: "fc00::/7",
    risk: "private-lan",
    // /7 = top 7 bits of the group: 1111 110x → mask 0xfe00 (fc00 or fd00).
    matches: (g) => (g[0] & 0xfe00) === 0xfc00,
  },
  {
    id: "ipv6-link-local",
    cidr: "fe80::/10",
    risk: "link-local",
    matches: (g) => (g[0] & 0xffc0) === 0xfe80,
  },
  {
    id: "ipv6-multicast",
    cidr: "ff00::/8",
    risk: "reserved",
    matches: (g) => (g[0] & 0xff00) === 0xff00,
  },
];

/**
 * SEC-04: the exported single-facts-source deny table (see the doc above).
 * Frozen so consumers (tests, docs tooling) can iterate the authoritative
 * list but not mutate it.
 */
export const SSRF_DENY_HOST_PATTERNS = Object.freeze({
  ipv4: Object.freeze(IPV4_DENY_SEGMENTS),
  ipv6: Object.freeze(IPV6_DENY_SEGMENTS),
});

/**
 * Shared risk classifier behind all three SSRF guards (SEC-04). Returns the
 * risk class of an IP literal, or null for non-IP strings.
 */
export function classifyAddressRisk(addr: string): AddressRisk | null {
  if (!isIP(addr)) return null;
  // N25: same IPv4-mapped/compatible normalization as before —
  // ::ffff:169.254.169.254 must classify as link-local, not "public".
  addr = normalizeIpForClassification(addr);
  if (isIP(addr) === 4) {
    const v = addr.split(".").map(Number);
    for (const segment of SSRF_DENY_HOST_PATTERNS.ipv4) {
      if (segment.matches(v)) return segment.risk;
    }
    return "public";
  }
  const groups = parseIpv6Groups(addr);
  if (!groups) return null; // unreachable for isIP===6; fail closed anyway
  for (const segment of SSRF_DENY_HOST_PATTERNS.ipv6) {
    if (segment.matches(groups)) return segment.risk;
  }
  return "public";
}

/**
 * SEC-04: id of the `SSRF_DENY_HOST_PATTERNS` segment that classified `addr`
 * ("ipv6-unique-local", "ipv4-cgnat", ...), or null when the address is
 * public / not an IP literal. Guard-specific refinements (the git face's
 * IPv6-ULA block) key on this instead of re-sniffing address text, so they
 * follow the table automatically.
 */
export function addressRiskSegmentId(addr: string): string | null {
  if (!isIP(addr)) return null;
  addr = normalizeIpForClassification(addr);
  if (isIP(addr) === 4) {
    const v = addr.split(".").map(Number);
    for (const segment of SSRF_DENY_HOST_PATTERNS.ipv4) {
      if (segment.matches(v)) return segment.id;
    }
    return null;
  }
  const groups = parseIpv6Groups(addr);
  if (!groups) return null;
  for (const segment of SSRF_DENY_HOST_PATTERNS.ipv6) {
    if (segment.matches(groups)) return segment.id;
  }
  return null;
}

/**
 * R4: SSRF guard for `git clone` targets (application deployFromGit).
 *
 * The format regex in deployFromGit only checks the URL SHAPE — a
 * well-formed http://169.254.169.254/... or git@127.0.0.1:repo would make
 * the clone an outbound request straight into cloud metadata / loopback.
 * This helper reuses the same parse + classify machinery as
 * assertSafeExecutorUrl (normalizeIpForClassification + classifyAddressRisk)
 * with the webhook/AI posture for the truly dangerous ranges. SEC-04: the
 * ranges themselves come from the unified SSRF_DENY_HOST_PATTERNS table —
 * this wrapper only contributes the git-specific shape parsing (https/ssh/
 * scp-like) and the IPv6-ULA block:
 *  - ALWAYS blocked: link-local / cloud metadata (169.254.169.254),
 *    loopback (127.0.0.0/8, ::1), unspecified/reserved (0.x, multicast),
 *    benchmarking (198.18/15) and CGNAT (100.64/10), IPv6 ULA fc00::/7.
 *  - ALLOWED: public addresses (behavior unchanged) and private LAN
 *    ranges (10/8, 172.16/12, 192.168/16) — self-hosted GitLab/Gitea on
 *    the internal network is a documented topology, so the blanket RFC1918
 *    deny used for webhook/AI targets would break legitimate installs.
 *
 * Accepted repo shapes: `https?://host/...`, `ssh://[user@]host[:port]/...`
 * and the scp-like `git@host:path` form. Anything else is rejected (the
 * caller's format regex already gates the shape; this is defense in depth).
 *
 * Residual risk (same as assertSafeHttpUrl): DNS rebinding — the address
 * checked here and the one `git` later resolves can differ. Pinning would
 * require rewriting the clone target to the resolved IP with a Host/SNI
 * header, which breaks TLS and virtual-hosted git servers; left as a
 * follow-up, like the maxRedirects note in the axios call sites.
 */
export async function assertSafeGitRepoUrl(rawRepo: string): Promise<void> {
  let host: string;
  const scpMatch = /^[A-Za-z0-9._-]+@([A-Za-z0-9.\-]+):/.exec(rawRepo);
  if (/^https?:\/\//i.test(rawRepo)) {
    let url: URL;
    try {
      url = new URL(rawRepo);
    } catch {
      throw new BadRequestException(`Invalid git repository URL: ${rawRepo}`);
    }
    // B-2 (SEC-NEW): http(s) repo URLs must never embed credentials. On a
    // failed clone git echoes the full remote URL to stderr, which lands in
    // errMsg → logs/callback/audit. Credentials go through GIT_ASKPASS / a
    // credential helper / ~/.netrc, never in the URL (mirror of the
    // executor-side gitRepo guard in executor-python execute.py).
    if (url.username || url.password) {
      throw new BadRequestException(
        `Git repository URL must not contain embedded credentials — ` +
          `use GIT_ASKPASS / a credential helper instead: ${stripUserinfo(rawRepo)}`,
      );
    }
    host = url.hostname;
  } else if (/^ssh:\/\//i.test(rawRepo)) {
    let url: URL;
    try {
      url = new URL(rawRepo);
    } catch {
      throw new BadRequestException(`Invalid git repository URL: ${rawRepo}`);
    }
    // B-2: a bare user (`ssh://git@host/...`) is the documented SSH shape;
    // a password (`ssh://user:pass@host/...`) is always a leaked credential.
    // The scp-like `git@host:path` form cannot carry a password by construction.
    if (url.password) {
      throw new BadRequestException(
        `Git repository URL must not contain an embedded password — ` +
          `use an SSH key / GIT_ASKPASS instead: ${stripUserinfo(rawRepo)}`,
      );
    }
    host = url.hostname;
  } else if (scpMatch) {
    host = scpMatch[1];
  } else {
    throw new BadRequestException(
      `Unsupported git repository URL shape: ${rawRepo}`,
    );
  }
  host = host.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new BadRequestException(
      `Git repository URL missing host: ${rawRepo}`,
    );
  }

  const check = (addr: string) => {
    const risk = classifyAddressRisk(addr);
    // R4: public + private-lan allowed; loopback/link-local/reserved/
    // restricted (benchmark, CGNAT) refused. IPv6 ULA classifies as
    // private-lan but is NOT a documented git topology — block it like
    // the webhook/AI guard does (N32 posture). SEC-04: the ULA refinement
    // keys on the unified segment id instead of re-sniffing address text.
    const segment = addressRiskSegmentId(addr);
    const isUla = segment === "ipv6-unique-local";
    if ((risk === "public" || risk === "private-lan") && !isUla) return;
    throw new BadRequestException(
      `Git repository host ${host} resolves to ${addr} (${risk}) — clone refused (SSRF guard)`,
    );
  };

  if (isIP(host)) {
    check(host);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new BadRequestException(
      `Failed to resolve git repository host ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addrs.length === 0) {
    throw new BadRequestException(
      `Git repository host ${host} did not resolve — clone refused`,
    );
  }
  for (const a of addrs) {
    check(a.address);
  }
}

/**
 * F-3: SSRF guard for outbound requests whose target is an EXECUTOR address
 * (registered via /api/executors/register or carried in deployment rows).
 *
 * SEC-04: a thin posture wrapper over the unified SSRF_DENY_HOST_PATTERNS
 * table via classifyAddressRisk — the segment list itself lives in one place.
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

  // ARCH-27/W-22 豁免说明: EXECUTOR_ALLOW_PRIVATE_NETWORK 已在
  // configuration.ts (executor.allowPrivateNetwork) + Joi 注册，运行时标准
  // 消费路径是 ConfigService；但本函数是被 executor.service / executor.controller /
  // app-deployment.service / executor-package.service 多处调用的无 DI 纯函数，
  // 若改签名注入 ConfigService 值需波及 5 个调用点及其 spec（超出本次收口
  // 边界）。故按"求值期/无 DI"豁免路径经 getEnvVar() 收口，调用时读取，
  // 测试仍可用 env 直接操纵（safe-http.util.spec / ssrf-deny-matrix.spec）。
  const allowPrivateNetwork =
    getEnvVar("EXECUTOR_ALLOW_PRIVATE_NETWORK") === "true";

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
