/**
 * R77（2026-11-06）：**地址分类 + 开关表**的零依赖纯函数出口（node 侧）。
 *
 * ## 为什么单独一个文件
 *
 * ADR-035 的跨端判据要「两侧**真跑**」：admin 侧已有零依赖的
 * `apps/admin-api/src/common/utils/address-category.util.ts` +
 * `outbound-posture.util.ts`，仓外探针可直接 require。node 侧此前没有等价出口：
 * 同一批判定住在 `lib/ssrf-guard.ts`，而那个文件顶部 `import { config } from
 * '../config'`（+ `node:dns`）⇒ 仓外 `import` 会因「目录导入 / 无扩展名」直接失败
 * （R77 实测：`Directory import '.../src/config' is not supported`）。
 *
 * 本文件**零 import**：地址表（契约 `networkPolicy.metadataAddresses` 的生成物）
 * 由调用方以 `metadata` 入参传入 —— 与 admin 的 `outbound-posture.util.ts` 同款
 * 设计（那里也把恒拒表作为入参，换取零依赖）。仓外探针因此可以：
 *
 *   const { categoryAllowed, classifyRestrictedIpv4 } = await import('.../address-category.ts');
 *   const METADATA = contract.networkPolicy.metadataAddresses.addresses; // 逐字从契约读
 *
 * ## 纪律
 *
 * · 判据只有这一份：`lib/ssrf-guard.ts` 逐字委托到本文件（包装时传生成物），
 *   任何一处改判定都必须改这里；
 * · 本文件**不许**新增 import（一加就失去仓外可 require 的性质）。
 */
/**
 * 把 IPv6 字面量展开成 8 个 16-bit 分组。接受的写法：完整式、压缩式（::）、
 * 末尾内嵌点分 IPv4（::ffff:1.2.3.4）、带 zone id（fe80::1%eth0）、带方括号。
 * 无法解析时返回 null（调用方按 fail-closed 处理）。
 *
 * R74-A1（安全面四轴审计·轴 1）：旧实现是**字符串前缀黑名单**，而 WHATWG URL
 * 会把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]——点分形态永远到不了
 * isRestrictedIpv4，于是整条**可连回环**的映射地址放行；fe80::/10 只黑
 * fe80/fe81/fe82 三个前缀（fe90/feb0/febf 漏网）；ff00::/8 组播完全未覆盖。
 * 改成「展开成数字分组后按位判定」后，判定与字面写法彻底解耦。
 */
function parseIpv6Groups(raw: string): number[] | null {
  let text = String(raw).trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  // 内嵌点分 IPv4 → 折叠成两个十六进制分组（::ffff:1.2.3.4 → ::ffff:102:304）
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const octets = text.slice(lastColon + 1).split('.');
    if (octets.length !== 4) return null;
    // R74-A1 复核修正：原写法是 /^d{1,3}$/（漏了反斜杠），合法十进制段一律不匹配 →
    // 返回 null → 调用方 fail-closed 判为「受限」。方向安全，但会把**公网**的内嵌点分地址
    // （如 ::ffff:8.8.8.8）也误判成受限。实际不可达（WHATWG URL 一定把点分形态规范化成
    // ::ffff:808:808），属休眠缺陷；仍按「解析器要自洽」修掉，解析失败依旧 fail-closed。
    const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hi = ((nums[0] << 8) | nums[1]).toString(16);
    const lo = ((nums[2] << 8) | nums[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const gap = text.indexOf('::');
  if (gap >= 0 && text.indexOf('::', gap + 1) >= 0) return null; // 多个 '::' 非法
  let groups: string[];
  if (gap >= 0) {
    const head = text.slice(0, gap);
    const tail = text.slice(gap + 2);
    const headParts = head === '' ? [] : head.split(':');
    const tailParts = tail === '' ? [] : tail.split(':');
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 1) return null; // '::' 至少要压缩一组
    groups = [...headParts, ...(Array.from({ length: missing }, () => '0') as string[]), ...tailParts];
  } else {
    groups = text.split(':');
    if (groups.length !== 8) return null;
  }
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

/** 把内嵌在 IPv6 里的两组 16-bit 还原成 IPv4 点分串后复用同一套受限判定。 */
function isRestrictedIpv4Pair(hi: number, lo: number, metadata: readonly string[]): boolean {
  return isRestrictedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, metadata);
}

/**
 * 按位判定 IPv6 受限地址：未指定/回环、IPv4-mapped（::ffff:0:0/96）、
 * IPv4-compatible（::/96）、NAT64（64:ff9b::/96）、6to4（2002::/16）、
 * link-local（fe80::/10）、ULA（fc00::/7）、组播（ff00::/8）。
 */
function isRestrictedIpv6Groups(groups: number[], metadata: readonly string[]): boolean {
  const [a, b, c, d, e, f] = groups;
  const embeddedV4 = (): boolean => isRestrictedIpv4Pair(groups[6], groups[7], metadata);

  if (groups.every((v) => v === 0)) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && groups[6] === 0 && groups[7] === 1) {
    return true; // ::1
  }
  // ::ffff:0:0/96 —— IPv4-mapped（同时覆盖 ::ffff:7f00:1 这类十六进制形态）
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return embeddedV4();
  // ::/96 —— IPv4-compatible（已废弃，但内核仍按 IPv4 语义处理）
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return embeddedV4();
  // 64:ff9b::/96 —— NAT64 翻译到内网 IPv4
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return embeddedV4();
  // 2002::/16 —— 6to4，地址里内嵌 IPv4
  if (a === 0x2002) return isRestrictedIpv4Pair(b, c, metadata);
  // fe80::/10 link-local（fe80–febf）
  if ((a & 0xffc0) === 0xfe80) return true;
  // fc00::/7 ULA（fc00–fdff）
  if ((a & 0xfe00) === 0xfc00) return true;
  // ff00::/8 组播（含 solicit-node 组播，可用来打内网主机）
  if ((a & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * IPv6 受限地址判定（loopback / link-local / ULA / 组播 / IPv4-mapped 受限）。
 * 与 isRestrictedHost 的 IPv6 分支共享——DNS 复核也用它判 AAAA 记录。
 * 解析失败按 fail-closed 处理（无法证明安全即视为受限）。
 */
export function isRestrictedIpv6Address(ipv6Raw: string, metadata: readonly string[]): boolean {
  const groups = parseIpv6Groups(ipv6Raw);
  if (!groups) return true;
  return isRestrictedIpv6Groups(groups, metadata);
}

/**
 * Parse a hostname (may be a DNS name, IPv4 literal, or IPv6 literal in
 * brackets) and determine whether it resolves to a private/loopback/link-local
 * address. DNS names are checked only for `localhost` and its synonyms;
 * actual DNS resolution lives in `assertSafeDnsResolution` (S-1) — this
 * function is URL-syntax based.
 *
 * R63：判定链已改为「分类 → 契约开关表」（`isRestrictedAddressForPolicy` +
 * `categoryAllowed`），本函数作为**布尔视图**保留并导出。
 *
 * R68（2026-11-06）：**改为直接委托分类器**。此前它是第二份实现（自己抄了一遍
 * `localhost` 同义词、去括号、IPv6/IPv4 分支），已经漂移：`foo.localhost`
 * 分类器判 `loopback`、这里判「不受限」；`192.0.0.192`（R09 加入的恒拒表）
 * 分类器判 `reserved`、这里按 IPv4 段规则判「不受限」。两个函数同名不同判，
 * 正是本仓反复出现的「同一判据两套表」。现在只有一份权威：
 * `isRestrictedAddressForPolicy(host) !== null`。
 */
export function isRestrictedHost(hostname: string, metadata: readonly string[]): boolean {
  return isRestrictedAddressForPolicy(hostname, metadata) !== null;
}

export function isRestrictedIpv4(ip: string, metadata: readonly string[]): boolean {
  // R68：契约恒拒表（metadataAddresses）必须先判 —— 此前这里漏了，导致
  // `192.0.0.192`（R09 追加的 Oracle 元数据）在布尔视图里判「不受限」，
  // 而分类器判 `reserved`。布尔视图与分类器必须同判（见 posture-matrix.spec）。
  if (isMetadataAddress(ip, metadata)) return true;

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
  // R77：198.18.0.0/15 benchmark 段。admin-api 的 SSRF_DENY_HOST_PATTERNS 里它是 `restricted`，
  // 而本侧一直没有 —— `ssrf-deny-parity.spec.ts` 第一次跑就把它揪出来了
  // （`::ffff:198.18.0.1` 经 IPv4-mapped 落到这里，返回 false ⇒ 整条放行）。
  // 这一段不可路由，但**用途是压测/基准**，落到真实网络里可能被中间设备当公网处理。
  if (a === 198 && (b === 18 || b === 19)) return true;

  return false;
}

// ── R2-1/P1b · A7：**分类**版的受限地址判定 ─────────────────────────────────
//
// 背景：`isRestrictedIpv4` / `isRestrictedIpv6Groups` 只回答「是否受限」，
// 而契约 `networkPolicy.switch` 要求「开关**只**放行 privateIPv4，其余六类在
// 任何开关状态下都拒」—— 知道「是哪一类」才能按契约决定开关能不能放行它。
//
// **本函数不重写判定**：它复用上面同一批按位判定，只是**返回类别**而不是布尔。
// ⇒ 七类地址清单仍只有一份权威（上面的 `isRestrictedIpv4` / 按位 IPv6 判定），
// 开关语义只有一份（protocol.json 的 `networkPolicy.switch`），
// 两者在本仓的**组合规则**在 `git-repo-network-policy.ts`。
//
// 返回值 `null` = 不受限（公网地址），或**无法识别的形状**（主机名）。
// 主机名的判定需要 DNS，属异步面（见 `git-repo-network-policy.ts` 的 async 闸）。

/** 契约 `networkPolicy.addresses` 的七类（键名逐字对应 protocol.json）。 */
export type RestrictedCategory =
  | "loopback"
  | "privateIPv4"
  | "linkLocal"
  | "cgnat"
  | "unspecified"
  | "multicast"
  | "reserved";

/**
 * 契约 `networkPolicy.switch.semantics` 的唯一语义：
 * **开关开启 ⇒ 放行 privateIPv4；其余六类在任何开关状态下都拒。**
 *
 * R63（2026-11-06，承接 ADR-032）：这张表现在由**下载面与 gitRepo 面共用同一份
 * 实现**（此前它只活在 `git-repo-network-policy.ts`，而下载面是
 * `if (allow) return;` ⇒ 开关一开就把 `169.254.169.254`（云元数据）/
 * `fd00:ec2::254`（AWS IPv6 元数据）/ CGNAT / unspecified / multicast /
 * reserved / loopback 全部放行）。**同一个开关、两条出站通道、两种承诺**，
 * 与 ADR-032 记录的 python 缺陷同族（那边是「除 loopback 外全放」）。
 *
 * 判定必须**先于**开关早退：开关是「是否解锁 privateIPv4」的谓词，不是
 * 「跳过整张表」的开关。`protocol.json` 的 `networkPolicy.metadataAddresses`
 * 更在其上（任何姿态、任何开关都拒，见 `isMetadataAddress`）。
 */
export function categoryAllowed(
  category: RestrictedCategory | null,
  allowPrivate: boolean,
): boolean {
  if (category === null) return true; // 公网地址 / 主机名（DNS 面另行判定）
  if (category === 'privateIPv4') return allowPrivate;
  return false; // loopback / linkLocal / cgnat / unspecified / multicast / reserved
}

/**
 * IPv4 分类。**顺序即规格**：先判更具体的段。
 *
 * 与 `isRestrictedIpv4` 的判据**完全一致**（同一批网段、同一顺序），只是
 * 返回类别。两者若将来出现分歧，`ssrf-policy-parity.spec.ts` 会红
 * （它逐段比对「受限 ⇒ 必返回非 null」与「非受限 ⇒ 必返回 null」）。
 */
export function classifyRestrictedIpv4(
  ip: string,
  metadata: readonly string[],
): RestrictedCategory | null {
  // R09（2026-11-05，ADR-029 §7）：契约 metadataAddresses 命中 ⇒ 归 reserved（任何开关都拒）。
  if (isMetadataAddress(ip, metadata)) return "reserved";

  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null;
  const [a, b] = octets;

  if (a === 127) return "loopback"; // 127.0.0.0/8
  if (a === 10) return "privateIPv4"; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return "privateIPv4"; // RFC1918 /12
  if (a === 192 && b === 168) return "privateIPv4"; // RFC1918 /16
  if (a === 169 && b === 254) return "linkLocal"; // 含云元数据 169.254.169.254
  if (a === 0) return "unspecified"; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return "cgnat"; // 100.64/10
  if (a === 224 || (a >= 225 && a <= 239)) return "multicast"; // 224.0.0.0/4
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // 198.18/15 benchmark
  if (a >= 240) return "reserved"; // 240.0.0.0/4 + 255.255.255.255
  return null;
}

/**
 * IPv6 分类。复用 `parseIpv6Groups` 的展开结果，按位判定后归入七类。
 *
 * 归类口径（与契约 `networkPolicy.addresses` 的语义对齐）：
 *   · `::1` / IPv4-mapped 到回环 → loopback
 *   · `fe80::/10` → linkLocal
 *   · `fc00::/7`（ULA，含 AWS IPv6 元数据 `fd00:ec2::254`）→ linkLocal
 *     （契约把云元数据整体归 linkLocal；ULA 段也是不可路由的本地地址）
 *   · `ff00::/8` → multicast
 *   · `::` → unspecified
 *   · IPv4-mapped / NAT64 / 6to4 → 递归分类内嵌 IPv4
 *   · 其余按位判定为受限者 → reserved
 */
export function classifyRestrictedIpv6(
  ipv6Raw: string,
  metadata: readonly string[],
): RestrictedCategory | null {
  const groups = parseIpv6Groups(ipv6Raw);
  if (!groups) return "reserved"; // 解析失败 = 无法证明安全（与 isRestrictedIpv6Address 同）
  const [a, b, c, d, e, f] = groups;

  if (groups.every((v) => v === 0)) return "unspecified"; // ::
  if (
    a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 &&
    groups[6] === 0 && groups[7] === 1
  ) {
    return "loopback"; // ::1
  }
  // IPv4-mapped（::ffff:0:0/96）/ IPv4-compatible（::/96）/ NAT64（64:ff9b::/96）
  //
  // R2-1/R5（契约 networkPolicy 新增 `ipv4Mapped` 类，Lead 裁定 Q-A ①）：
  // 映射形态**完全按内嵌 IPv4 判定** —— 内嵌 IPv4 属七类中的哪一类就用哪一类
  // （含其开关语义）；内嵌是**公网**则**放行**。
  //
  // ⚠️ **改前**：映射形态**一律归 `reserved`** ⇒ 连内嵌公网（`::ffff:8.8.8.8`）
  // 也拒。⇒ **本次是 node 侧的行为变更**（放宽，见报告的行为变更表）。
  // 改动的**动机**是让两侧与契约一致：python 侧本来就是「按内嵌 IPv4 判」。
  const embedded = (): RestrictedCategory | null =>
    classifyRestrictedIpv4(
      `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`,
      metadata,
    );
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return embedded(); // 内嵌公网 ⇒ null（放行）；内嵌受限 ⇒ 那一类
  }
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) {
    return embedded() ?? "reserved";
  }
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return embedded() ?? "reserved";
  }
  // 2002::/16 6to4：内嵌 IPv4
  if (a === 0x2002) {
    return classifyRestrictedIpv4(`${b >> 8}.${b & 0xff}.${c >> 8}.${c & 0xff}`, metadata) ?? "reserved";
  }
  if ((a & 0xffc0) === 0xfe80) return "linkLocal"; // fe80::/10
  if ((a & 0xfe00) === 0xfc00) return "linkLocal"; // fc00::/7 ULA（含 fd00:ec2::254）
  if ((a & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  return null;
}

/**
 * 统一入口：给定「主机名或 IP 字面量」，返回受限类别（`null` = 不受限或无法识别）。
 *
 * localhost 同义词归 loopback；IPv6 字面量（可带方括号/zone id）走 IPv6 分类；
 * 其余尝试 IPv4 分类；都不是（= 主机名）返回 `null`（DNS 判定属异步面）。
 */
/**
 * R08（2026-11-05，ADR-029）：**该地址是否在契约的元数据恒拒表里**。
 *
 * 语义：任何 posture × 任何开关状态都 DENY（判定必须在风险分类与开关早退**之前**）。
 * 地址表来自 `protocol.json` 的 `networkPolicy.metadataAddresses` 生成物，勿手改。
 * 与 admin / python 两侧逐字节同源（同一份生成物）。
 */
export function isMetadataAddress(hostRaw: string, metadata: readonly string[]): boolean {
  const host = (hostRaw || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  return metadata.some((entry) => String(entry).split('/')[0].trim() === host);
}

export function isRestrictedAddressForPolicy(
  hostRaw: string,
  metadata: readonly string[],
): RestrictedCategory | null {
  const host = (hostRaw || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return null;
  // R08/ADR-029：元数据地址先判 ⇒ 归 `reserved`（该类在契约里任何开关都拒）。
  if (isMetadataAddress(host, metadata)) return "reserved";
  if (host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost")) {
    return "loopback";
  }
  if (host.includes(":")) return classifyRestrictedIpv6(host, metadata);
  return classifyRestrictedIpv4(host, metadata);
}
