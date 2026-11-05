/**
 * R76：**地址分类的零依赖纯函数**（与 `outbound-posture.util.ts` 同一风格）。
 *
 * ## 为什么要有这个文件
 *
 * `safe-http.util.ts` 里的 `classifyAddressRisk` / `isMetadataAddress` 是「地址 →
 * 决定」链的**前半段**：后半段（`outbound-posture.util.ts` 的姿态判定）已经在
 * R74 抽成纯函数。但前半段仍住在带 Nest 依赖链的文件里（`AppError` / `ErrorCode` /
 * `getEnvVar` …）⇒ 仓外判据要「给一个地址、问它会不会被 webhook 面放行」，就
 * **必须**起 ts-node 子进程把整个 `safe-http.util.ts` 拉进来。
 *
 * 本文件把前半段也抽出来 ⇒ 仓外探针只需 require 这**两个**零依赖模块
 * （分类 + 姿态），就能**端到端**算出「这个地址在 webhook 面会不会被放行」，
 * **不需要 ts-node 子进程**。
 *
 * ## 依赖清点（为什么「零依赖」不是口号）
 *
 * 原实现用到的外部东西**只有三样**，且都不是 Nest / env / IO：
 *   · `node:net` 的 `isIP` —— 标准库，无副作用；
 *   · 本文件内的 **段表**（`IPV4_DENY_SEGMENTS` / `IPV6_DENY_SEGMENTS`）—— 纯数据；
 *   · 契约生成物 `METADATA_ADDRESSES` —— 纯数据（常量数组）。
 * ⇒ 段表与生成物**以入参传入**（`AddressCategoryTables`），本模块自身**零 import**
 * —— 连 `node:net` 都不 import（`isIP` 也作为入参传入），因此它在**任何**运行时
 * （Node / 浏览器 / 仓外探针）里都能直接 require。
 *
 * ## 判定语义
 *
 *   ① **恒拒表先于分类**（ADR-029 硬要求 ②）：命中 `metadataAddresses` ⇒ 归
 *      `reserved`（任何 posture × 任何开关都拒）；
 *   ② **段表** —— 按 `ip`/`ipv6` 两张段表逐段匹配，命中即得该段的 `risk`；
 *   ③ **公网兜底** —— 两张表都没命中 ⇒ `public`（= 不受限）。
 *
 * 与 admin 的**粗标签**体系一致（ADR-033 §2.2）：`restricted` 同时装着
 * CGNAT(100.64/10) 与 benchmark(198.18/15)；`reserved` 同时装着
 * unspecified(0/8) + multicast(224/4) + reserved(240/4)。
 */

/** admin 侧的粗标签（与 `safe-http.util.ts` 的 `AddressRisk` 逐字一致）。 */
export type AddressCategory =
  | "public"
  | "private-lan"
  | "loopback"
  | "link-local"
  | "restricted"
  | "reserved";

/** Every non-public risk class carried by the unified deny table. */
export type SsrfDenyRisk = Exclude<AddressCategory, "public">;

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
 * 一张段（与 `safe-http.util.ts` 的 `SsrfDenySegment*` **同构**，字段名逐字一致）。
 *
 * 字段名刻意保持 `matches`（admin 侧原本就是这个名字，IPv4 表与 IPv6 表各用
 * 自己的入参形状：前者是四个八位组，后者是八个 16 位组）⇒ 装配时**零转换**，
 * 也避免「转换层写错 ⇒ 段表静默不匹配」这种难查的失真。
 */
export interface AddressSegment {
  /** 稳定标识（`ipv4-cgnat` 等）。 */
  readonly id: string;
  /** 该段命中的地址归成哪个类别。 */
  readonly risk: AddressCategory;
  /** 匹配器：IPv4 表传四个八位组，IPv6 表传八个 16 位组。 */
  readonly matches: (parts: readonly number[]) => boolean;
}

/** 分类所需的**全部数据**（由调用方传入 ⇒ 本模块零 import）。 */
export interface AddressCategoryTables {
  /** IPv4 段表（顺序即匹配顺序 —— **先命中先归类**）。 */
  readonly ipv4: readonly AddressSegment[];
  /** IPv6 段表（顺序同上）。 */
  readonly ipv6: readonly AddressSegment[];
  /** 契约恒拒表（`networkPolicy.metadataAddresses.addresses` 的成员，形如 `1.2.3.4/32`）。 */
  readonly metadataAddresses: readonly string[];
  /** `node:net` 的 `isIP`（注入以保持本模块零 import）。 */
  readonly isIP: (addr: string) => number;
}

/** 分类结果。 */
export interface AddressClassification {
  /** 归类（`public` = 不受限）；`null` = 不是 IP 字面量。 */
  readonly category: AddressCategory | null;
  /** 是否命中契约恒拒表（**恒拒先于分类**，ADR-029）。 */
  readonly metadata: boolean;
  /** 命中恒拒表时仍返回分类（admin 侧把元数据归 `reserved`）。 */
  readonly segmentId: string | null;
}

/**
 * 判定一个地址是否命中契约恒拒表。
 *
 * 纯函数：只读入参里的地址表；不做 DNS、不读 env、不抛异常。
 */
export function classifyMetadataAddress(
  hostOrAddr: string,
  tables: Pick<AddressCategoryTables, "metadataAddresses" | "isIP">,
): boolean {
  const raw = String(hostOrAddr ?? "")
    .trim()
    .replace(/^\[|\]$/g, "");
  if (!raw || !tables.isIP(raw)) return false;
  const target = normalizeIpLiteral(raw, tables);
  return tables.metadataAddresses.some((entry) => {
    // 契约目前只登记单主机（/32）；非 /32 网段**不支持**（按 ADR-029 §2 的扩展
    // 规则再加，绝不静默放过）。
    const base = String(entry).split("/")[0].trim();
    if (!base || !tables.isIP(base)) return false;
    return normalizeIpLiteral(base, tables) === target;
  });
}

/**
 * 把 IPv4-mapped / IPv4-compatible 字面量折回内嵌 IPv4（admin 侧 `normalizeIpForClassification`
 * 的**纯逻辑副本**，逐字等价）。
 *
 * 为什么需要：`::ffff:169.254.169.254` 若不折回内嵌 IPv4，IPv4 规则全部落空 ⇒
 * 该地址会被归成 `public`（可放行）——那是一条绕过整张地址表的门。
 */
export function normalizeIpLiteral(
  addr: string,
  tables: Pick<AddressCategoryTables, "isIP">,
): string {
  if (tables.isIP(addr) !== 6) return addr;
  const groups = parseIpv6Groups(addr);
  if (!groups) return addr;
  const highZeros =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0;
  const isMapped = highZeros && groups[5] === 0xffff; // ::ffff:0:0/96
  // ::/96 IPv4-compatible：只在真的内嵌了 IPv4 时才改写
  // （groups[6] 非零（形如 ::7f00:1） 或文本里有点分四段（::127.0.0.1））。
  // `::` 与 `::1` 保持 IPv6 语义（环回/未指定的处理依赖它）。
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
 * 把 IPv6 字面量解析成八个 16 位组（处理 `::` 压缩与末尾内嵌点分四段）。
 * 非法输入返回 `null`（调用方按 fail-closed 处理）。
 */
export function parseIpv6Groups(addr: string): number[] | null {
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
      // 内嵌 IPv4 四段只允许出现在最后两个组的位置。
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
 * 命中地址的**段 id**（`ipv4-cgnat` 等），或 `null`（公网 / 非 IP 字面量）。
 *
 * 与 `classifyAddress` 的区别只在于「返回什么」：这里返回**唯一标识**，
 * 供 git 面等按段做特判的实现 keying 用（它们**不该**再自己嗅探地址文本）。
 * 判定顺序与 `classifyAddress` **完全同源**（同一张段表、同一个归一化），
 * 因此两者不可能给出互相矛盾的结论。
 */
export function addressSegmentId(
  addr: string,
  tables: Pick<AddressCategoryTables, "ipv4" | "ipv6" | "isIP">,
): string | null {
  if (!tables.isIP(addr)) return null;
  const normalized = normalizeIpLiteral(addr, tables);
  if (tables.isIP(normalized) === 4) {
    const v = normalized.split(".").map(Number);
    for (const segment of tables.ipv4) {
      if (segment.matches(v)) return segment.id;
    }
    return null;
  }
  const groups = parseIpv6Groups(normalized);
  if (!groups) return null;
  for (const segment of tables.ipv6) {
    if (segment.matches(groups)) return segment.id;
  }
  return null;
}

/**
 * 地址分类（admin 侧 `classifyAddressRisk` 的纯逻辑副本，逐字等价）。
 *
 * @param addr 地址字面量（IPv4 / IPv6 / IPv4-mapped / IPv4-compatible）
 * @param tables 分类所需的全部数据（段表 + 恒拒表 + `isIP`）
 */
export function classifyAddress(
  addr: string,
  tables: AddressCategoryTables,
): AddressClassification {
  if (!tables.isIP(addr)) {
    return { category: null, metadata: false, segmentId: null };
  }
  const normalized = normalizeIpLiteral(addr, tables);
  // ① 恒拒表先于分类（ADR-029 硬要求 ②）：命中 ⇒ 归 `reserved`。
  const metadata = classifyMetadataAddress(normalized, tables);
  if (metadata) {
    return { category: "reserved", metadata: true, segmentId: null };
  }
  if (tables.isIP(normalized) === 4) {
    const v = normalized.split(".").map(Number);
    for (const segment of tables.ipv4) {
      if (segment.matches(v)) {
        return {
          category: segment.risk,
          metadata: false,
          segmentId: segment.id,
        };
      }
    }
    return { category: "public", metadata: false, segmentId: null };
  }
  const groups = parseIpv6Groups(normalized);
  if (!groups) {
    // isIP===6 却解析不出组 ⇒ 理论上不可达；此处 fail-closed（不归 public）。
    return { category: null, metadata: false, segmentId: null };
  }
  for (const segment of tables.ipv6) {
    if (segment.matches(groups)) {
      return {
        category: segment.risk,
        metadata: false,
        segmentId: segment.id,
      };
    }
  }
  return { category: "public", metadata: false, segmentId: null };
}

// ── 段表（R76 从 safe-http.util.ts 整段搬来：单一事实源，纯数据）──

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
    // ⚠️ **契约归类修正（2026-11-05，安全）**：本段原标 `private-lan`。
    // `protocol.json` 的 `networkPolicy.addresses.linkLocal` 明确写
    // 「fc00::/7（ULA，**含 AWS IPv6 元数据 `fd00:ec2::254`**）」且
    // `allowedUnderPrivateNetwork: **false**` ⇒ **恒拒**。
    // 原分类的后果（实测）：`http://[fd00:ec2::254]/latest/` 在**两种开关状态下都被放行**
    // ⇒ **IPv6 云元数据可达**（dispatch / broadcast / package push / gitRepo 全走这条出站闸）。
    // 为什么不是"再给各姿态加一条 ULA 特判"：`assertSafeGitRepoUrl` 早就加过
    // （见其 `isUla` 分支），而**执行器姿态忘了** ⇒ 这正是"每个姿态各自特判"必然产生的漏洞。
    // ⇒ 改**分类本身**：ULA 归 `linkLocal`（契约如此）⇒ 所有姿态自动恒拒，一处修彻底。
    id: "ipv6-unique-local",
    cidr: "fc00::/7",
    risk: "link-local",
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
