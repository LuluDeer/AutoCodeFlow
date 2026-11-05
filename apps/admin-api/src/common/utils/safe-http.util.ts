import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
// tsconfig 未开 esModuleInterop（仅 allowSyntheticDefaultImports）——默认导入在
// CJS 下会取 `.default`（undefined）。必须用命名空间导入才能拿到真实模块。
import * as http from "node:http";
import * as https from "node:https";
// ARCH-27: 本文件是无 DI 的纯工具函数，无法注入 ConfigService —— env 读取
// 统一经 src/config/env.ts 收口（全仓唯一直读通道）。
import { getEnvVar } from "../../config/env";
import { METADATA_ADDRESSES } from "../../generated/protocol-metadata-addresses";
// LANG-ERR-01: SSRF 拒绝文案改为稳定错误码（文案由前端按用户语言渲染）。
// ⚠️ 本文件是出站请求的唯一咽喉，zh 文案与迁移前逐字一致——两处 spec 按文本
// 断言（/拒绝名单/、/已拒绝克隆/ 等），改措辞即改契约。
import { AppError } from "../errors/app-error";
import { ErrorCode } from "../errors/error-codes";
// R74：出站姿态判定抽成**零依赖纯函数**（无 Nest / 无 env / 无 IO），
// 让仓外判据（scripts/ 的四向检查）能直接 require 它把 webhook 面纳入真跑比对。
// 本文件改为**逐字委托**给它 ⇒ 行为零变化。
import { evaluateOutboundPosture } from "./outbound-posture.util";
// R76：地址分类抽成**零依赖纯函数**（连 `node:net` 都不 import —— `isIP` 也是
// 入参），让仓外探针把「地址 → 类别 → 姿态决定」整条链端到端跑起来。
import {
  addressSegmentId,
  buildAddressCategoryTables,
  classifyAddress,
  classifyMetadataAddress,
  isLoopbackHostname,
  type AddressCategoryTables,
} from "./address-category.util";

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
 *    allowed by default; loopback gated by EXECUTOR_ALLOW_PRIVATE_NETWORK;
 *    restricted/benchmark/CGNAT + link-local + reserved always refused);
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
    throw new AppError(ErrorCode.SSRF_URL_INVALID, { url: rawUrl });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(ErrorCode.SSRF_PROTOCOL_NOT_HTTP, {
      protocol: url.protocol,
    });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new AppError(ErrorCode.SSRF_HOST_MISSING);
  if (url.username || url.password) {
    // B-2: credentials in the URL would leak through logs/error reports.
    throw new AppError(ErrorCode.SSRF_CREDENTIALS_IN_URL, {
      url: stripUserinfo(rawUrl),
    });
  }

  const isExecutor = opts.policy === "executor";
  const allowPrivateNetwork =
    opts.allowPrivateNetwork ??
    (isExecutor
      ? getEnvVar("EXECUTOR_ALLOW_PRIVATE_NETWORK") === "true"
      : false);

  // R66（ADR-032 收口）：webhook 面姿态与契约**逐类同构**。
  // 契约 `networkPolicy.switch.semantics`：「开关开启 ⇒ 放行 privateIPv4；
  // 其余五类（loopback / linkLocal / cgnat / unspecified / multicast /
  // reserved）一律仍拒」。⇒ 开关的**唯一**效果是解锁 `private-lan`。
  //
  // 修复前 webhook 面在开关开启时还放行 `loopback` 与 `restricted`
  // （= cgnat 100.64/10 + benchmark 198.18/15）⇒ 比契约宽两类：
  //   · loopback —— 契约 `loopback.allowedUnderPrivateNetwork=false`
  //     （契约 $comment 原文：「loopback（打自己回环）… 在任何开关状态下都拒」）；
  //   · restricted —— 契约 `cgnat.allowedUnderPrivateNetwork=false`。
  // 恒拒表（`metadataAddresses`）**先于**本谓词判定（ADR-029 的硬要求，
  // 位置不变，见下方 IP 字面量与 DNS 答案两处分支）。
  const allowedWebhook = (risk: AddressRisk | null): boolean =>
    evaluateOutboundPosture({
      risk,
      metadata: false,
      allowPrivateNetwork,
      posture: "webhook",
    }).allowed;
  // assertSafeExecutorUrl posture（R05 起与契约**逐格一致**）：
  // `public` 恒放行；`private-lan` **只在开关开启时**放行；其余（loopback / link-local /
  // restricted / unspecified / multicast / reserved）**任何开关状态都拒**。
  //
  // R01（2026-11-05）：`restricted`（benchmark 198.18/15、CGNAT 100.64/10）从「开关可解锁」
  // 组里摘出 —— 契约 `cgnat.allowedUnderPrivateNetwork=false`，node/python 两态都拒。
  //
  // R05（2026-11-05）：另两格按契约收口 ——
  //   · `privateIPv4.allowedUnderPrivateNetwork = true` ⇒ 私网**默认拒**、开关才放行
  //     （此前 admin 是「private-lan 恒放行」⇒ `grid:privateIPv4@off:admin` 不一致）；
  //   · `loopback.allowedUnderPrivateNetwork = false` + `switch.semantics`「开关开启 ⇒ 放行
  //     privateIPv4，其余一律仍拒」⇒ loopback **恒拒**、开关不解锁（此前 admin 把 loopback
  //     放进解锁组 ⇒ `grid:loopback@on:admin` 不一致）。
  // 契约 `switch.$comment` 原话：「loopback（打自己回环）… 在任何开关状态下都拒」。
  // 部署后果：内网执行器现在必须显式 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（compose 默认栈
  // 已在 admin-api 服务里置 true；见 docker-compose.yml）。真四向检查逐格盯这两格。
  const allowedExecutor = (risk: AddressRisk | null): boolean =>
    evaluateOutboundPosture({
      risk,
      metadata: false,
      allowPrivateNetwork,
      posture: "executor",
    }).allowed;
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
      throw new AppError(ErrorCode.SSRF_HOST_UNRESOLVABLE, { host });
    }
    return addr;
  };

  if (isIP(host)) {
    // R08/ADR-029：元数据地址恒拒（先于 posture/开关）
    if (isMetadataAddress(host)) {
      throw new AppError(ErrorCode.SSRF_HOST_DENIED_PINNED, { host });
    }
    if (!allowedRisk(classifyAddressRisk(host))) {
      throw new AppError(ErrorCode.SSRF_HOST_DENIED_PINNED, { host });
    }
    return { url, pinnedIp: host, pinned: false };
  }

  // R80：`localhost` 系主机名**先于 DNS** 拒绝（否则 DNS 解析到公网即旁路）。
  // 语义来源：契约 `loopback.description`「localhost / *.localhost /
  // localhost.localdomain」；RFC 6761 §6.3 把 `*.localhost` 定为回环专用名
  // ⇒ 拒绝与「解析成什么」无关。复用 R79 的零依赖纯函数（不写第二份）。
  // 错误码变化（R80，刻意）：DNS 失败路径的 SSRF_HOST_DNS_LOOKUP_FAILED →
  // 这里换成 SSRF_HOST_DENIED_PINNED（"在拒绝名单内" 才是事实）。
  if (isLoopbackHostname(host)) {
    throw new AppError(ErrorCode.SSRF_HOST_DENIED_PINNED, { host });
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new AppError(ErrorCode.SSRF_HOST_DNS_LOOKUP_FAILED, {
      host,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (addrs.length === 0) {
    throw new AppError(ErrorCode.SSRF_HOST_UNRESOLVABLE, { host });
  }
  const allowed: string[] = [];
  for (const a of addrs) {
    // R08/ADR-029：解析到的地址同样先判元数据（DNS 指向元数据端点必须恒拒）
    if (isMetadataAddress(a.address)) {
      throw new AppError(ErrorCode.SSRF_RESOLVED_TO_BLOCKED_ADDRESS_PINNED, {
        host,
        address: a.address,
      });
    }
    const risk = classifyAddressRisk(a.address);
    if (!allowedRisk(risk)) {
      throw new AppError(ErrorCode.SSRF_RESOLVED_TO_BLOCKED_ADDRESS_PINNED, {
        host,
        address: a.address,
      });
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
 *
 * R08（2026-11-05，ADR-029）：**云元数据地址恒拒** —— 契约 `networkPolicy.metadataAddresses`
 * 列出的地址**任何 posture × 任何开关状态**都 DENY（判定先于风险分类）。
 * 原先「restricted 随开关放行」的语义只覆盖 `restricted` 的**非元数据**成员
 * （Tailscale CGNAT、RFC2544）；文档里那句「云元数据恒拒」现在才真正成立。
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
    throw new AppError(ErrorCode.SSRF_URL_INVALID, { url: rawUrl });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(ErrorCode.SSRF_PROTOCOL_NOT_HTTP, {
      protocol: url.protocol,
    });
  }
  // SEC-04: strip the WHATWG IPv6 brackets (url.hostname keeps "[::1]") so
  // IPv6 literals reach the unified classifier exactly like the executor/git
  // guards do. Previously bracketed literals fell into the DNS path below
  // and were only refused incidentally — and platform-dependently
  // (Linux getaddrinfo rejects "[::1]", Windows accepts it).
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new AppError(ErrorCode.SSRF_HOST_MISSING);

  const allowPrivateNetwork = opts?.allowPrivateNetwork === true;

  // 姿态与契约同构（R66）：`public` 恒放行；`private-lan` 只在开关开启时放行；
  // 其余（loopback / link-local / restricted / reserved）**任何开关状态都拒**。
  // 恒拒表（`metadataAddresses`）在下方两处分支里**先于**本谓词判定。
  // 报错文案保持默认路径历史措辞（既有 spec 逐字匹配）。
  const allowedRisk = (risk: AddressRisk | null): boolean =>
    evaluateOutboundPosture({
      risk,
      metadata: false,
      allowPrivateNetwork,
      posture: "webhook",
    }).allowed;

  // If the host is an IP literal we can decide synchronously.
  if (isIP(host)) {
    // R08/ADR-029：元数据地址恒拒（先于 posture/开关）
    if (isMetadataAddress(host)) {
      throw new AppError(ErrorCode.SSRF_HOST_DENIED, { host });
    }
    if (!allowedRisk(classifyAddressRisk(host))) {
      throw new AppError(ErrorCode.SSRF_HOST_DENIED, { host });
    }
    return url;
  }
  // Hostname: resolve via DNS and check every answer.
  // R80：同 assertAndPinHttpUrl —— `localhost` 系主机名先于 DNS 拒绝。
  // 错误码变化（R80，刻意）：SSRF_HOST_DNS_LOOKUP_FAILED → SSRF_HOST_DENIED。
  if (isLoopbackHostname(host)) {
    throw new AppError(ErrorCode.SSRF_HOST_DENIED, { host });
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new AppError(ErrorCode.SSRF_HOST_DNS_LOOKUP_FAILED, {
      host,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (addrs.length === 0) {
    throw new AppError(ErrorCode.SSRF_HOST_UNRESOLVABLE, { host });
  }
  for (const a of addrs) {
    // R08/ADR-029：解析到的地址先判元数据
    if (isMetadataAddress(a.address)) {
      throw new AppError(ErrorCode.SSRF_RESOLVED_TO_BLOCKED_ADDRESS, {
        host,
        address: a.address,
      });
    }
    if (!allowedRisk(classifyAddressRisk(a.address))) {
      throw new AppError(ErrorCode.SSRF_RESOLVED_TO_BLOCKED_ADDRESS, {
        host,
        address: a.address,
      });
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

// R76：段表（`SSRF_DENY_HOST_PATTERNS`）与其类型搬到零依赖纯函数模块，
// 这里 re-export 维持既有 import 面（spec 与其他模块仍从本文件取）。
export {
  SSRF_DENY_HOST_PATTERNS,
  type SsrfDenyRisk,
  type SsrfDenySegmentIpv4,
  type SsrfDenySegmentIpv6,
} from "./address-category.util";

/**
 * R78：分类表的装配在这里完成（`safe-http.util.ts` 是**唯一**装配点）。
 *
 * 为什么装配在这一侧：契约恒拒表是生成物，纯函数模块必须**零 import**（仓外探针
 * 用 `--experimental-strip-types` 直接 require 它，任何相对导入都可能解析失败）。
 * ⇒ 恒拒表由本文件 import 并作为入参传进去；段表仍只在纯函数模块里有一份。
 */
const ADDRESS_CATEGORY_TABLES: AddressCategoryTables =
  buildAddressCategoryTables(isIP, METADATA_ADDRESSES);

/**
 * Shared risk classifier behind all three SSRF guards (SEC-04). Returns the
 * risk class of an IP literal, or null for non-IP strings.
 */
export function classifyAddressRisk(addr: string): AddressRisk | null {
  // R76：逐字委托给零依赖纯函数（判定语义完全不变，见 address-category.util.ts
  // 的「判定语义」三条：恒拒表先于分类 → 段表 → 公网兜底）。
  return classifyAddress(addr, ADDRESS_CATEGORY_TABLES).category;
}

/**
 * R08（2026-11-05，ADR-029）：**元数据地址恒拒** —— 判定必须在风险分类**之前**。
 *
 * 为什么单独一层：`restricted` 里同时装着「合法的内网拓扑」（Tailscale `100.64/10`、
 * RFC2544）与「必须恒拒的云元数据端点」（阿里云 `100.100.100.200`，实测落在这个段里）。
 * webhook 面把 `restricted` 放在「开关开启才放行」组 ⇒ 开关一开元数据端点即可达，
 * 与文档承诺的「云元数据恒拒」冲突（R07 实测）。ADR-029 裁定：把元数据地址从
 * `restricted` 拆出单列，任何 posture / 任何开关都 DENY；地址表来自契约
 * `networkPolicy.metadataAddresses`（生成物，勿手改）。
 */
export function isMetadataAddress(hostOrAddr: string): boolean {
  // R76：逐字委托给零依赖纯函数（恒拒表先于分类的语义不变）。
  return classifyMetadataAddress(hostOrAddr, ADDRESS_CATEGORY_TABLES);
}

/**
 * SEC-04: id of the `SSRF_DENY_HOST_PATTERNS` segment that classified `addr`
 * ("ipv6-unique-local", "ipv4-cgnat", ...), or null when the address is
 * public / not an IP literal. Guard-specific refinements (the git face's
 * IPv6-ULA block) key on this instead of re-sniffing address text, so they
 * follow the table automatically.
 */
export function addressRiskSegmentId(addr: string): string | null {
  // R77：逐字委托给零依赖纯函数（与 classifyAddress 同源，见 address-category.util.ts）。
  return addressSegmentId(addr, ADDRESS_CATEGORY_TABLES);
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
      throw new AppError(ErrorCode.GIT_REPO_URL_INVALID, { url: rawRepo });
    }
    // B-2 (SEC-NEW): http(s) repo URLs must never embed credentials. On a
    // failed clone git echoes the full remote URL to stderr, which lands in
    // errMsg → logs/callback/audit. Credentials go through GIT_ASKPASS / a
    // credential helper / ~/.netrc, never in the URL (mirror of the
    // executor-side gitRepo guard in executor-python execute.py).
    if (url.username || url.password) {
      throw new AppError(ErrorCode.GIT_REPO_URL_CREDENTIALS, {
        url: stripUserinfo(rawRepo),
      });
    }
    host = url.hostname;
  } else if (/^ssh:\/\//i.test(rawRepo)) {
    let url: URL;
    try {
      url = new URL(rawRepo);
    } catch {
      throw new AppError(ErrorCode.GIT_REPO_URL_INVALID, { url: rawRepo });
    }
    // B-2: a bare user (`ssh://git@host/...`) is the documented SSH shape;
    // a password (`ssh://user:pass@host/...`) is always a leaked credential.
    // The scp-like `git@host:path` form cannot carry a password by construction.
    if (url.password) {
      throw new AppError(ErrorCode.GIT_REPO_URL_PASSWORD, {
        url: stripUserinfo(rawRepo),
      });
    }
    host = url.hostname;
  } else if (scpMatch) {
    host = scpMatch[1];
  } else {
    throw new AppError(ErrorCode.GIT_REPO_URL_FORM_UNSUPPORTED, {
      url: rawRepo,
    });
  }
  host = host.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new AppError(ErrorCode.GIT_REPO_HOST_MISSING, { url: rawRepo });
  }

  const check = (addr: string) => {
    // R08/ADR-029：元数据地址恒拒（先于分类/姿态）
    if (isMetadataAddress(addr)) {
      throw new AppError(ErrorCode.GIT_REPO_HOST_BLOCKED, {
        host,
        address: addr,
        risk: "reserved",
      });
    }
    const risk = classifyAddressRisk(addr);
    // public + private-lan allowed; loopback/link-local/reserved/
    // restricted (benchmark, CGNAT) refused.
    // ⚠️ 2026-11-05：IPv6 ULA **不再需要在这里特判** —— 它已在分类表里归 `linkLocal`
    // （契约如此，含 AWS IPv6 元数据 `fd00:ec2::254`）⇒ 上面的 `risk` 判断已自动拒绝它。
    // 原来这里的 `isUla` 特判是"各姿态各自补洞"的产物：git 面补了、**执行器面忘了**
    // ⇒ 云元数据在 dispatch/broadcast/package push 上可达。现在洞从**分类**上堵掉，
    // 特判随之删除（留着的死代码会让人以为 ULA 还需要特殊对待）。
    if (risk === "public" || risk === "private-lan") return;
    throw new AppError(ErrorCode.GIT_REPO_HOST_BLOCKED, {
      host,
      address: addr,
      risk,
    });
  };

  if (isIP(host)) {
    check(host);
    return;
  }
  // R81：`localhost` 系主机名**先于 DNS** 拒绝（同 webhook 面，见 ADR-036 §3.3）。
  // 复用 R79 的零依赖纯函数（不写第二份）。错误码保留本面既有语义：
  // 「地址判定层拒绝」⇒ GIT_REPO_HOST_BLOCKED（不是 webhook 面的 SSRF_HOST_DENIED——
  // 两面的调用方与文案域不同，混用会让运维按错误域排查）。
  if (isLoopbackHostname(host)) {
    throw new AppError(ErrorCode.GIT_REPO_HOST_BLOCKED, { host });
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new AppError(ErrorCode.GIT_REPO_HOST_DNS_LOOKUP_FAILED, {
      host,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (addrs.length === 0) {
    throw new AppError(ErrorCode.GIT_REPO_HOST_UNRESOLVABLE, { host });
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
 *  - Restricted ranges — 198.18.0.0/15 (RFC 2544 benchmarking) and
 *    100.64.0.0/10 (RFC 6598 CGNAT, Tailscale overlays) — are **always
 *    refused**, in both switch states (R01, 2026-11-05). Contract
 *    `networkPolicy.addresses.cgnat.allowedUnderPrivateNetwork = false`, and
 *    executor-node / executor-python refuse them in both states; admin was the
 *    only outlier (four-way check `grid:cgnat@on:admin`). `100.64.0.0/10`
 *    contains the Aliyun metadata endpoint `100.100.100.200`, so "the flag
 *    unlocks CGNAT" was a credential-exfiltration surface, not a policy
 *    preference. assertSafeHttpUrl blocks them outright as well.
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
    throw new AppError(ErrorCode.EXECUTOR_URL_INVALID, { url: rawUrl });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(ErrorCode.EXECUTOR_URL_PROTOCOL_NOT_HTTP, {
      protocol: url.protocol,
    });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new AppError(ErrorCode.EXECUTOR_URL_HOST_MISSING);
  // Credentials in the URL would end up in logs/error reports — reject them.
  if (url.username || url.password) {
    throw new AppError(ErrorCode.EXECUTOR_URL_CREDENTIALS);
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
    // R08/ADR-029：元数据地址恒拒（先于分类/姿态；开关救不了它）
    if (isMetadataAddress(addr)) {
      throw new AppError(ErrorCode.EXECUTOR_HOST_BLOCKED, {
        host,
        address: addr,
        risk: "reserved",
      });
    }
    const risk = classifyAddressRisk(addr);
    if (risk === "public") return;
    // R01（2026-11-05）：`restricted`（benchmark 198.18/15、CGNAT 100.64/10）不随开关放行。
    // R05（2026-11-05）：`private-lan` 改为**开关才放行**（契约 allowedUnderPrivateNetwork=true），
    // `loopback` 改为**恒拒**（契约 false + switch.semantics「其余一律仍拒」）。
    // 与 `assertAndPinHttpUrl({policy:'executor'})` 的 `allowedExecutor` **必须同口径**
    // （真四向检查的「第四面」逐输入逐态比对这两个入口，分叉即红）。
    if (risk === "private-lan" && allowPrivateNetwork) return;
    throw new AppError(ErrorCode.EXECUTOR_HOST_BLOCKED, {
      host,
      address: addr,
      risk,
    });
  };

  if (isIP(host)) {
    check(host);
    return url;
  }
  // R81：同 git 面 —— `localhost` 系主机名先于 DNS 拒绝（ADR-036 §3.3）。
  // 错误码保留本面既有语义 ⇒ EXECUTOR_HOST_BLOCKED。
  if (isLoopbackHostname(host)) {
    throw new AppError(ErrorCode.EXECUTOR_HOST_BLOCKED, { host });
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new AppError(ErrorCode.EXECUTOR_HOST_DNS_LOOKUP_FAILED, {
      host,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (addrs.length === 0) {
    throw new AppError(ErrorCode.EXECUTOR_HOST_UNRESOLVABLE, { host });
  }
  for (const a of addrs) {
    check(a.address);
  }
  return url;
}
