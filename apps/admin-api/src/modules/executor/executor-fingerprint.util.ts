/**
 * ARCH-36（ADR-017 阶段 2）：`deviceFingerprint` 的**校验**与**冲突观测**
 * 单一事实源。
 *
 * ── 这一层要回答的问题 ───────────────────────────────────────────────────
 * `address` 是唯一键，但它自报、可变、NAT 下可碰撞。P0 已用「被顶替的进程生命
 * 复活」这条**时序**判据让并存变可见（`executor-address-conflict.util.ts`），
 * 代价是：它只能间接推断，且漏报面取决于上报节奏（两台机器错峰、或一方长时间
 * 不发心跳时检不出）。
 *
 * `deviceFingerprint` 跨重启**不变**，于是判据从时序变成**直接比较**：
 *
 *   两个**不同** fingerprint 落在**同一行**（同一 executors.id）
 *     → 一份安装的身份被另一份顶替 = **硬冲突** `row-identity-overwrite`
 *       （零误报：正常重启不换指纹；盐文件被删后重建才会换，而那本身也是要
 *       暴露的事）
 *
 *   同一 address 上出现两个不同 fingerprint，且该地址上有 **push 行**
 *     → 地址是 push 行的**路由面**（唯一索引 `uq_executors_address WHERE
 *       dispatchMode='push'`），撞了就是真故障 `push-address-collision`
 *       （HTTP 下发会打到错误的那台机器）
 *
 *   同一 address 上两个不同 fingerprint，全是 **pull 行**
 *     → **不是冲突**（`addressSharedByMultipleRows`，只记 info）。ADR-017 §5
 *       明确允许该形态：队列键是行 id、恢复按行身份，各自成行互不影响。
 *       ⚠️ 这正是本模块 2026-10-22 的生产误报来源：判据曾停在"阶段 2"的
 *       「同址第二个指纹即冲突」，于是全 pull 机队每 10 分钟收到一条无意义告警。
 *
 *   同一个 fingerprint 换成另一个 address
 *     → 同一份安装换了地址上报 = **地址漂移**（机器换网/换 IP），属正常，
 *       不是冲突。**必须与硬冲突分开**：把漂移报成冲突会让每次换网都告警。
 *
 * 三条方向各自零误报，这是本模块与 P0 跟踪器的分工——P0 管进程生命，本模块管
 * 安装身份。判据与**行语义**对齐（阶段 3 复查补口）：调用方必须用
 * `observeWithContext` 传入 `rowId` 与 `dispatchMode`，否则退回"未知模式 =
 * 按 push 处理"的保守口径（与派发面同策，宁可多报不漏报）。
 *
 * ── 与 P0 的关系（刻意的重复而非替换）───────────────────────────────────
 * 两者**并存**、不互相替代：
 * - P0 的判据不依赖新字段，对存量执行器（未上报 fingerprint）依然有效；
 * - 本模块的判据更硬，但只在执行器升到协议 v3 后才可用。
 * 迁移期正是两者并存的窗口；待阶段 3 落地、存量机队全部上报后，P0 的时序判据
 * 可作为交叉校验保留（它覆盖的是"同一安装两份进程"这种指纹判不出的形态——
 * 同机同 kind 同 workDir 的两个实例会共享指纹，那时 P0 是唯一判据）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * - **纯内存、零依赖、零 IO**：在 register/heartbeat 热路径上被调用（心跳 30s
 *   一次/台），不得引入 DB/网络往返（对齐 P0 跟踪器与 `interpreter-match.util`）。
 * - **有界**：地址表与每地址指纹表都有上限，超限按最旧淘汰；惰性 TTL 清扫，
 *   不引入定时器（对齐 `tokenValidationCache` 的 MAX+TTL 先例）。
 * - **旧执行器零影响**：指纹缺省（null/undefined/非法）时不登记、不判定、不
 *   告警——存量未上报该字段的执行器行为与引入本特性前逐字节一致。
 * - **实例而非模块级单例**：理由同 P0 跟踪器（模块级可变状态跨测试文件泄漏，
 *   仓库有 `__resetTruncationWarnStateForTest` 的前科）。
 *
 * ── ADR-017 阶段 3 追加 ───────────────────────────────────────────────────
 * `legacyExecutorIdentity` / `isLegacyExecutorIdentity`：未上报指纹的存量
 * 执行器在库中的**身份兜底键**（详见下方 helper 注释）。这两个纯函数只被
 * 服务层 register 与迁移回填使用，不在心跳热路径上。
 */

import { createHash } from "crypto";

/** 指纹的合法形态：sha256 的 64 位小写十六进制，与执行器侧同源。 */
export const DEVICE_FINGERPRINT_HEX_LENGTH = 64;

/**
 * ADR-017 阶段 3：`deviceFingerprint` 列宽（迁移 1790000000054 后为
 * VARCHAR(80)）。raw legacy 形态 `legacy:` + address 必须 ≤ 80；超长时
 * 退化为 hash 形态（73 字符），两种形态都必须装得下。
 */
export const DEVICE_FINGERPRINT_COLUMN_LENGTH = 80;

/**
 * legacy 身份键前缀（两种形态都以 `legacy` 开头，与 64 位十六进制指纹互斥
 * ——真实指纹不可能以字母开头）。
 *
 * 语义（ADR-017 §6 阶段 3）：未上报指纹的存量执行器（协议 < 3）不因缺
 * 指纹被拒，其行身份用 `legacy:${address}` 兜底（换地址 = 换键 = 新行，
 * 行为与引入指纹前**逐字节一致**）；升级到协议 v3 后首注册即被采纳为真实
 * 指纹、行身份接管（见 register 的 adoption 分支）。
 */
export const LEGACY_FINGERPRINT_PREFIX = "legacy";

/**
 * 计算未上报指纹执行器的**服务端生成**身份键（不与执行器上报值混淆）。
 *
 * - 常规形态：`legacy:${address}`（人类可读、可反查地址）；
 * - 超长地址：`legacy-h:` + sha256(address)（73 字符，确定性、无碰撞）。
 *
 * 边界精确值：前缀 `legacy:` 是 7 字符，hash 形态 `legacy-h:`(9) + 64 = 73 字符。
 * 故 address 长度 **≤ 73** 走常规形态（最长恰好 80 字符，装满列宽），
 * **≥ 74** 走 hash 形态。IPv4 `ip:port` ≈ 21 字符、常规主机名远在界内，
 * 只有超长主机名才可能触发 hash 形态。
 *
 * 该键**只由中台生成并落库**（register 创建行/迁移回填），执行器永不
 * 上报、也永不作为查询键使用——legacy 行始终按 `address` 定位。它存在的
 * 意义是让 `deviceFingerprint` 列保持 NOT NULL、且不与任何真实指纹混淆。
 * 迁移回填 SQL 与本函数必须同形（迁移 spec 双向断言）。
 */
export function legacyExecutorIdentity(address: string): string {
  const raw = `${LEGACY_FINGERPRINT_PREFIX}:${address}`;
  if (raw.length <= DEVICE_FINGERPRINT_COLUMN_LENGTH) return raw;
  return `${LEGACY_FINGERPRINT_PREFIX}-h:${createHash("sha256")
    .update(address)
    .digest("hex")}`;
}

/**
 * 判定存储值是否为 legacy 身份键（而非执行器上报的真实指纹）。
 *
 * 语义：`legacy` 前缀（`legacy:` / `legacy-h:`）与真实指纹的 64 位十六进制
 * 字符集互斥（`'l'` 不是十六进制字符），故前缀判断**零误报**。
 *
 * ## 用途（如实说明，勿夸大——审查曾指出旧注释声称它驱动 register）
 *
 * 它是「这个存储值是不是 legacy 键」的**规范判据**，被 util 自身的测试与
 * 需要区分两种身份形态的调用方/工具使用。**生产链路上的 register/heartbeat
 * 并不调用它**：那两条路径要的是「能否作为**真实指纹**参与定位比较」，故直接
 * 用 `normalizeDeviceFingerprint(value)` —— 该函数对 legacy 键与 NULL 一律返回
 * `null`（即"不是真实指纹"），一次调用同时覆盖两种「非真实指纹」形态，比
 * 「先判 legacy 再判 NULL」更少分支。
 *
 * 两者的等价性由 util spec 的 legacy 用例钉住：若将来有人改宽 `FINGERPRINT_RE`
 * （例如允许大写或加长），`normalize` 的判定会变，而本函数不会——那时
 * `normalize(...) === null` 与 `isLegacyExecutorIdentity(...)` 就将分叉。
 * 保留本函数是为了让「legacy 形态」有一个**显式**表达（读代码的人不必从
 * "null 意味着什么"反推），并给需要它的调用方一个稳定入口。
 */
export function isLegacyExecutorIdentity(
  value: string | null | undefined,
): boolean {
  return (
    typeof value === "string" && value.startsWith(LEGACY_FINGERPRINT_PREFIX)
  );
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** 每地址最多记住多少个不同指纹（FIFO 淘汰最旧）。 */
export const MAX_FINGERPRINTS_PER_ADDRESS = 8;

/** 每指纹最多记住多少个地址（地址漂移历史，FIFO 淘汰最旧）。 */
export const MAX_ADDRESSES_PER_FINGERPRINT = 8;

/** 地址表上限（与 P0 跟踪器的 MAX_TRACKED_ADDRESSES 同量级）。 */
export const MAX_TRACKED_ADDRESSES = 5000;

/** 条目 TTL：超过该时长未再上报的地址被惰性清除（24h，与 P0 一致）。 */
export const FINGERPRINT_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

/** 同一 (address, fingerprint) 组合的告警节流窗口（10min，与 P0 一致）。 */
export const FINGERPRINT_ALERT_THROTTLE_MS = 10 * 60 * 1000;

/**
 * 指纹「在场」窗口（ADR-017 阶段 3 复查补口 · 冲突观测层）。
 *
 * 语义：某指纹在该地址上最后一次被观测到的时刻距今超过本值，就不再参与冲突
 * 判据（视为「这份安装已经不在这台地址上了」）。
 *
 * 为什么必须有这一层（生产实证，2026-10-22）：旧实现只给**地址条目**记
 * updatedAt，而条目时间被「该地址上任何一台的心跳」不断续期，fingerprints
 * 集合里的历史指纹因此**永不过期**——一台机器 7 小时前就被删了，告警仍在
 * 每 10 分钟外发一次（现场：198.18.0.1:8002 / 192.168.1.40:8002）。改按
 * **指纹各自**计在场后，第二个安装离场（≈ 本窗口）即自动收敛，不需要运维
 * 去删行、也不需要重启进程。
 *
 * 30min = 60 个心跳周期（心跳 30s）：足够覆盖 GC 停顿、网络抖动、缓存重建，
 * 又短到「DHCP 把同一 IP 先后分给两台机器」这类真冲突在有人处理之前不会
 * 自行漂白。
 */
export const FINGERPRINT_LIVENESS_MS = 30 * 60 * 1000;

/**
 * 规范化上报的指纹。
 *
 * 只接受 sha256 的十六进制形态，并统一小写——执行器两端都产出小写，但统一
 * 大小写可以避免「同一指纹因大小写差异被误判成两个安装」（那会产出**假**冲突，
 * 比漏报更糟：它会让运维去查一件不存在的事）。
 *
 * 空白/非字符串/长度或字符集不符 → null（调用方视同"未上报"，保留 DB 旧值）。
 */
export function normalizeDeviceFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return FINGERPRINT_RE.test(trimmed) ? trimmed : null;
}

/**
 * 冲突类型（ADR-017 阶段 3 复查补口）。
 *
 * 只有这两种形态是**真故障**；「pull 同址多行」不入此枚举——它是设计。
 */
export type FingerprintConflictKind =
  /** 地址是 push 行的路由面，却被另一份安装占用（HTTP 下发会打到错的行）。 */
  | "push-address-collision"
  /** 两份安装的指纹落在**同一行 id** 上（一份安装的身份被另一份顶替）。 */
  | "row-identity-overwrite";

/**
 * 观测上下文：行身份 + 派发模式。
 *
 * 阶段 3 把 `address` 从「身份键」降级为「可达性元数据」，但冲突观测层仍停留在
 * 阶段 2 的「同址第二个指纹 = 冲突」。补上这两个字段后，判据才能与行语义一致：
 * 有行身份时才谈得上「同一行被顶替」，有 push 行时地址才是路由面。
 *
 * 缺省语义（两字段都不传 / 传 null）= **未知**，按 push 处理——与派发面
 * （`resolveExecutorTransport` 对未知 dispatchMode 走 push）同口径，也让
 * 存量单测的「同址第二个指纹 = 冲突」语义逐字节不变。
 */
export interface FingerprintObserveContext {
  /** 本次上报所属执行器行 id（解析得到时）。 */
  rowId?: string | null;
  /** 该行的 dispatchMode（`'pull'` 才把同址多行视为合法形态）。 */
  dispatchMode?: string | null;
}

/** 触发观测时给出的完整结果（供调用方写日志/通知/审计）。 */
export interface FingerprintObservation {
  /** 规范化后的本次指纹。 */
  fingerprint: string;
  /** 本次上报来源地址。 */
  address: string;
  /** 该 address 上出现过的不同指纹数（含本次）。 */
  fingerprintsOnAddress: number;
  /**
   * 该 address 上出现过的**全部**不同指纹（含本次，按首次出现先后排列）。
   *
   * 为什么把清单而不只是计数带出来：告警只报"有 2 台机器共用这一行"而不说是
   * **哪两台**，运维仍要翻日志手工关联——处置动作（给每台机器唯一
   * `EXECUTOR_ADDRESS_PUBLIC`）需要的正是这份清单。与 P0 冲突告警同时给出
   * 「被顶替者」和「顶替者」两个 startupId 是同一考量的对称实现。
   *
   * 有界：≤ `MAX_FINGERPRINTS_PER_ADDRESS`（8），可直接进日志/通知载荷。
   */
  distinctFingerprintsOnAddress: string[];
  /** 该 fingerprint 出现过的不同地址数（含本次）。 */
  addressesForFingerprint: number;
  /**
   * **硬冲突类型**（ADR-017 阶段 3 复查补口）；`null` = 无冲突。
   *
   * - `push-address-collision`：该地址上**有 push 行的指纹**（含未上报
   *   dispatchMode 的未知/存量行），而 push 行的 `address` 是**路由面**
   *   （唯一索引 `uq_executors_address WHERE dispatchMode='push'`），撞了就是
   *   真故障：两台机器抢同一个 HTTP 入口，下发会打到错的那台。
   * - `row-identity-overwrite`：两个**不同指纹映射到同一行 id** —— 一份安装的
   *   身份被另一份顶替（阶段 2 判据原本想抓的形态）。
   *
   * 阶段 3 之后 **pull 模式的同址多行是设计允许的正常形态**（外键无唯一约束、
   * 队列键是行 id、恢复按行身份），因此「同址两个指纹但全是 pull」**不再是**
   * 冲突 —— 见 `addressSharedByMultipleRows`。
   */
  conflictKind: FingerprintConflictKind | null;
  /**
   * 该地址上**确实并存**了多份安装（≥2 个在场指纹）。
   *
   * 注意：本字段**不代表故障**。pull 模式下它是正常拓扑（同网段同 IP / Clash
   * 伪 IP / DHCP 复用），调用方只应记 info。真正的故障判据是 `conflictKind`。
   */
  addressSharedByMultipleRows: boolean;
  /**
   * **硬冲突**：`conflictKind !== null` 的布尔投影（保留字段名以兼容既有
   * 调用方/监控口径）。
   *
   * 语义：两台不同机器（或两份不同安装）正在共用同一**路由地址**或同一行。
   * 与 P0 的时序判据不同，这是**直接证据**——不依赖上报节奏。
   */
  addressSharedByMultipleInstalls: boolean;
  /**
   * **地址漂移**：同一安装换了新地址上报（机器换网/换 IP）。
   *
   * 属正常现象，**不是**冲突；单独成字段是为了让调用方只记 info，避免把
   * 「运维换了网段」升级成告警（狼来了）。
   */
  addressDrifted: boolean;
  /**
   * 本次是否因节流而未应告警。
   *
   * 语义：`addressSharedByMultipleInstalls=true && throttled=true` = 确实冲突，
   * 但同一 (address, fingerprint) 组合刚告警过，调用方应跳过外发只记 debug。
   */
  throttled: boolean;
  /**
   * 「pull 同址并存」这条 **info** 是否因节流而未应记录。
   *
   * 心跳 30s 一次 × N 台，若无节流会把日志刷成瀑布；与 throttled 分开计，
   * 互不影响。
   */
  infoThrottled: boolean;
}

/** 采集侧观测口径（回答"冲突率到底是多少"）。 */
export interface FingerprintStats {
  /** 累计观测次数（含未上报指纹的上报）。 */
  reports: number;
  /** 其中**携带**合法指纹的次数。 */
  reportsWithFingerprint: number;
  /** 已登记的地址数（上报过指纹的）。 */
  trackedAddresses: number;
  /** 其中检出「同一地址多个指纹」的地址数。 */
  addressesWithMultipleFingerprints: number;
  /** 已登记的指纹数。 */
  trackedFingerprints: number;
  /** 其中出现于多个地址的指纹数（地址漂移面）。 */
  fingerprintsOnMultipleAddresses: number;
  /**
   * 冲突率 = 多指纹地址数 / 已登记地址数；分母为 0 时返回 0。
   *
   * 注意口径：这是**当前存活窗口内**（TTL 24h）的观测，不是历史累计——表是有界
   * 的、条目会过期，故它是"近况"而非"总账"。需要历史趋势应落到指标系统，不在
   * 本模块范围（ADR-017 阶段 2 只要求观测可用）。
   */
  conflictRate: number;
}

/** 一条 (address, fingerprint) 观测记录（各自计在场，见 FINGERPRINT_LIVENESS_MS）。 */
interface AddressFingerprintEntry {
  /** 首次出现时刻（FIFO 淘汰序 / 告警文案「何时起」）。 */
  firstSeenAt: number;
  /** 最近一次上报时刻：超过 FINGERPRINT_LIVENESS_MS 即视为该安装已离场。 */
  lastSeenAt: number;
  /** 该指纹最近一次被观测到时所属的执行器行 id（识别「同一行被另一份安装顶替」）。 */
  rowId: string | null;
  /** 该行的 dispatchMode；null = 未上报/未知（按 push 处理，与派发面同口径）。 */
  dispatchMode: "push" | "pull" | null;
  /** 该 (address, fingerprint) 最近一次告警时刻，用于节流。 */
  lastAlertAt: number | null;
  /**
   * 该 (address, fingerprint) 最近一次「pull 同址并存」info 记录时刻。
   *
   * 与 lastAlertAt **分开**：info 节流绝不能吞掉后续真冲突的告警（同一地址
   * 先全 pull、后来一台 push 进场的形态虽然罕见，但吞掉就是漏报）。
   */
  lastInfoAt: number | null;
}

interface AddressEntry {
  /**
   * 该地址上出现过的指纹 → 观测记录（Map 保持插入序，FIFO 淘汰最旧）。
   *
   * ADR-017 阶段 3 复查补口：值从「首次出现时刻」升级为完整记录——只有
   * 记住 rowId / dispatchMode 才能按行语义判定冲突，只有各自记 lastSeenAt
   * 才能让「离场的安装」自动退出判据（旧实现只按地址续期 ⇒ 永久误报）。
   */
  fingerprints: Map<string, AddressFingerprintEntry>;
  /** 最近一次上报时刻（惰性 TTL 依据，仅用于整条地址条目的过期）。 */
  updatedAt: number;
}

/**
 * `deviceFingerprint` 冲突跟踪器。**非线程安全但单线程安全**——admin-api 是
 * 单进程事件循环模型；多副本部署下各副本独立观察，告警面（任一副本命中即发）
 * 承担可见性，与 P0 跟踪器同语义。
 */
export class DeviceFingerprintTracker {
  private readonly byAddress = new Map<string, AddressEntry>();
  private readonly byFingerprint = new Map<string, Map<string, number>>();
  private reports = 0;
  private reportsWithFingerprint = 0;

  /**
   * 记录一次执行器上报并判定冲突/漂移。
   *
   * @param address     执行器自报地址。
   * @param fingerprint 上报的指纹；非法/缺省 → 只计数 `reports`，返回 null。
   * @param now         当前时刻（可注入，便于测试）。
   * @returns 观测结果；指纹缺省/非法时返回 null。
   */

  observe(
    address: string,
    fingerprint: string | null | undefined,
    now: number = Date.now(),
  ): FingerprintObservation | null {
    // 兼容壳：不带行身份/派发模式 ⇒ 未知模式（按 push 处理），语义与引入
    // 阶段 3 判据前逐字节一致。生产调用点应使用 observeWithContext。
    return this.observeWithContext(address, fingerprint, {}, now);
  }

  /**
   * 记录一次执行器上报并判定**按行语义**的冲突/漂移（ADR-017 阶段 3）。
   *
   * @param address     执行器自报地址（阶段 3 之后它只是标签/可达性元数据）。
   * @param fingerprint 上报的指纹；非法/缺省 → 只计数 reports，返回 null。
   * @param ctx         行身份 + dispatchMode（决定「同址多行」是故障还是设计）。
   * @param now         当前时刻（可注入，便于测试）。
   * @returns 观测结果；指纹缺省/非法时返回 null。
   */
  observeWithContext(
    address: string,
    fingerprint: string | null | undefined,
    ctx: FingerprintObserveContext = {},
    now: number = Date.now(),
  ): FingerprintObservation | null {
    this.reports += 1;
    const normalized = normalizeDeviceFingerprint(fingerprint);
    if (!normalized || !address) return null;
    this.reportsWithFingerprint += 1;

    this.sweepExpired(now);

    const isNewAddress = !this.byAddress.has(address);
    if (isNewAddress) this.evictIfFull(now);

    const addressEntry = this.byAddress.get(address) ?? {
      fingerprints: new Map<string, AddressFingerprintEntry>(),
      updatedAt: now,
    };
    this.byAddress.set(address, addressEntry);
    addressEntry.updatedAt = now;

    // 在场判定：先把该地址上**已离场**的指纹清掉。旧实现让整条地址条目被
    // 「同址任何一台的心跳」续期，历史指纹永不退出 ⇒ 误报永久化（见
    // FINGERPRINT_LIVENESS_MS 注释）。
    this.pruneDepartedFingerprints(addressEntry, now);

    const normalizedMode: "push" | "pull" | null =
      ctx.dispatchMode === "pull"
        ? "pull"
        : ctx.dispatchMode === "push"
          ? "push"
          : null;
    const rowId =
      typeof ctx.rowId === "string" && ctx.rowId.length > 0 ? ctx.rowId : null;

    const existing = addressEntry.fingerprints.get(normalized);
    if (existing) {
      existing.lastSeenAt = now;
      // 行身份/模式以**最新**上报为准：pull 行可能被重建（新 id）、也可能
      // 从 push 改成 pull（协议 v3 升级）。只在本次给了值时才覆盖，避免
      // 旧执行器（不带 dispatchMode）把已知模式擦回未知。
      if (rowId) existing.rowId = rowId;
      if (normalizedMode) existing.dispatchMode = normalizedMode;
    } else {
      addressEntry.fingerprints.set(normalized, {
        firstSeenAt: now,
        lastSeenAt: now,
        rowId,
        dispatchMode: normalizedMode,
        lastAlertAt: null,
        lastInfoAt: null,
      });
      // 有界：FIFO 淘汰最旧的指纹（Map 保持插入序）。
      while (addressEntry.fingerprints.size > MAX_FINGERPRINTS_PER_ADDRESS) {
        const oldest = addressEntry.fingerprints.keys().next().value;
        if (oldest === undefined) break;
        addressEntry.fingerprints.delete(oldest);
      }
    }

    const fingerprintAddresses =
      this.byFingerprint.get(normalized) ?? new Map<string, number>();
    this.byFingerprint.set(normalized, fingerprintAddresses);
    const isNewAddressForFingerprint = !fingerprintAddresses.has(address);
    if (isNewAddressForFingerprint) {
      fingerprintAddresses.set(address, now);
      while (fingerprintAddresses.size > MAX_ADDRESSES_PER_FINGERPRINT) {
        const oldest = fingerprintAddresses.keys().next().value;
        if (oldest === undefined) break;
        fingerprintAddresses.delete(oldest);
      }
    }

    const liveFingerprints = [...addressEntry.fingerprints.keys()];
    const fingerprintsOnAddress = liveFingerprints.length;
    const addressSharedByMultipleRows = fingerprintsOnAddress > 1;
    // 冲突判据**按行语义**（阶段 3）：只有「地址是路由面却被撞」或「两份安装
    // 映射到同一行」才是故障；pull 的同址多行是设计允许的正常拓扑。
    // 用地址表（而非「本次是否新增」）判——冲突在被反复上报时必须持续为真
    // （否则第二次心跳就"痊愈"了，与 P0 的持续可检出语义不一致）。
    const conflictKind = this.classifyConflict(addressEntry, liveFingerprints);

    let throttled = false;
    if (conflictKind !== null) {
      throttled = this.isAlertThrottled(addressEntry, normalized, now);
    }
    // pull 同址并存（合法形态）只记一条 info —— 同样按窗口节流。
    const infoThrottled =
      conflictKind === null && addressSharedByMultipleRows
        ? this.isInfoThrottled(addressEntry, normalized, now)
        : false;

    return {
      fingerprint: normalized,
      address,
      fingerprintsOnAddress,
      distinctFingerprintsOnAddress: liveFingerprints,
      addressesForFingerprint: fingerprintAddresses.size,
      conflictKind,
      addressSharedByMultipleRows,
      addressSharedByMultipleInstalls: conflictKind !== null,
      // 漂移 = 本次给该指纹**新添**了一个地址（正是「机器换网/换 IP」那一刻）。
      // 刻意不让 isNewAddress 参与判定：换网场景下**新地址本身就是新地址**，
      // 若要求「该地址此前见过」才判漂移，恰好会把唯一的漂移时刻漏掉。
      // 也不用 addressesForFingerprint > 1——那是「曾经漂移过」的稳定属性而非
      // 本次事件，持续为真会让调用方每次心跳都记一条，日志没有信息量。
      addressDrifted:
        isNewAddressForFingerprint && fingerprintAddresses.size > 1,
      throttled,
      infoThrottled,
    };
  }

  /**
   * 冲突分类（阶段 3 行语义）。
   *
   * 顺序即优先级：**行身份优先于地址**——「两个指纹落在同一行」是身份被顶替，
   * 比「两个指纹落在同一地址的两行」严重得多（前者会互相改写元数据/令牌）。
   */
  private classifyConflict(
    entry: AddressEntry,
    liveFingerprints: string[],
  ): FingerprintConflictKind | null {
    if (liveFingerprints.length < 2) return null;

    const rowIdToFingerprint = new Map<string, string>();
    for (const fp of liveFingerprints) {
      const rowId = entry.fingerprints.get(fp)?.rowId ?? null;
      if (!rowId) continue;
      const owner = rowIdToFingerprint.get(rowId);
      if (owner !== undefined && owner !== fp) return "row-identity-overwrite";
      rowIdToFingerprint.set(rowId, fp);
    }

    // 地址是 push 行的**路由面**（唯一索引只约束 push 行）⇒ 撞了就是真故障。
    // dispatchMode 未知（存量执行器不报该字段）按 push 处理：与派发面
    // resolveExecutorTransport 的「未知 → push」同口径，宁可多报也不漏真故障。
    const hasRoutingSurface = liveFingerprints.some(
      (fp) => entry.fingerprints.get(fp)?.dispatchMode !== "pull",
    );
    if (hasRoutingSurface) return "push-address-collision";

    return null;
  }

  /**
   * info 节流（pull 同址并存的可见性提示）。
   *
   * 与 isAlertThrottled 同窗口、同键，但写**独立**的 lastInfoAt 字段——原因
   * 见该字段注释。
   */
  private isInfoThrottled(
    entry: AddressEntry,
    fingerprint: string,
    now: number,
  ): boolean {
    const rec = entry.fingerprints.get(fingerprint);
    const last = rec?.lastInfoAt ?? null;
    if (last !== null && now - last < FINGERPRINT_ALERT_THROTTLE_MS) {
      return true;
    }
    if (rec) rec.lastInfoAt = now;
    return false;
  }

  /** 清掉该地址上已离场的指纹（各自计时，不被同址其他安装续期）。 */
  private pruneDepartedFingerprints(entry: AddressEntry, now: number): void {
    for (const [fp, rec] of entry.fingerprints) {
      if (now - rec.lastSeenAt > FINGERPRINT_LIVENESS_MS) {
        entry.fingerprints.delete(fp);
      }
    }
  }

  /**
   * 节流判定：同一 (address, fingerprint) 在窗口内只应告警一次。
   * 命中即**记录本次告警时刻**（调用方据此外发一次）。
   */
  private isAlertThrottled(
    entry: AddressEntry,
    fingerprint: string,
    now: number,
  ): boolean {
    const rec = entry.fingerprints.get(fingerprint);
    const last = rec?.lastAlertAt ?? null;
    if (last !== null && now - last < FINGERPRINT_ALERT_THROTTLE_MS) {
      return true;
    }
    if (rec) rec.lastAlertAt = now;
    return false;
  }

  /** 惰性 TTL 清扫：过期地址条目（及其指纹反向索引）一并清除。 */
  private sweepExpired(now: number): void {
    if (this.byAddress.size === 0) return;
    for (const [address, entry] of this.byAddress) {
      if (now - entry.updatedAt > FINGERPRINT_ENTRY_TTL_MS) {
        this.byAddress.delete(address);
        for (const fingerprint of entry.fingerprints.keys()) {
          this.byFingerprint.get(fingerprint)?.delete(address);
          if (this.byFingerprint.get(fingerprint)?.size === 0) {
            this.byFingerprint.delete(fingerprint);
          }
        }
      }
    }
  }

  /** 地址表满时淘汰最久未更新的条目（O(n) 但仅在满表时触发，n ≤ 5000）。 */
  private evictIfFull(now: number): void {
    if (this.byAddress.size < MAX_TRACKED_ADDRESSES) return;
    this.sweepExpired(now);
    if (this.byAddress.size < MAX_TRACKED_ADDRESSES) return;
    let oldestAddress: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [address, entry] of this.byAddress) {
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestAddress = address;
      }
    }
    if (oldestAddress !== null) {
      const entry = this.byAddress.get(oldestAddress);
      this.byAddress.delete(oldestAddress);
      for (const fingerprint of entry?.fingerprints.keys() ?? []) {
        this.byFingerprint.get(fingerprint)?.delete(oldestAddress);
      }
    }
  }

  /**
   * 忘记某地址上的某份安装（或整个地址）。
   *
   * 为什么需要（阶段 3 复查补口）：行被**删除/自动清理**后，该安装在内存里
   * 仍是一条"在场指纹"，直到 FINGERPRINT_LIVENESS_MS 到期。真冲突一旦处理
   * 完（运维删掉多余行），告警应当在**同一时刻**停，而不是再响半小时。
   * 删除路径（removeById / cleanupOfflineExecutors）据此同步清条目。
   *
   * @param address     执行器地址。
   * @param fingerprint 省略 = 清掉该地址的全部指纹条目。
   */
  forget(address: string, fingerprint?: string | null): void {
    const entry = this.byAddress.get(address);
    if (!entry) return;
    const normalized = normalizeDeviceFingerprint(fingerprint);
    if (normalized) {
      entry.fingerprints.delete(normalized);
      this.forgetDriftIndex(address, [normalized]);
      if (entry.fingerprints.size === 0) this.byAddress.delete(address);
      return;
    }
    this.forgetDriftIndex(address, [...entry.fingerprints.keys()]);
    this.byAddress.delete(address);
  }

  /** 反向索引清理（地址 → 指纹的漂移历史）。 */
  private forgetDriftIndex(address: string, fingerprints: string[]): void {
    for (const fp of fingerprints) {
      const addresses = this.byFingerprint.get(fp);
      if (!addresses) continue;
      addresses.delete(address);
      if (addresses.size === 0) this.byFingerprint.delete(fp);
    }
  }

  /** 当前观测口径快照。 */
  stats(): FingerprintStats {
    let addressesWithMultipleFingerprints = 0;
    for (const entry of this.byAddress.values()) {
      if (entry.fingerprints.size > 1) addressesWithMultipleFingerprints += 1;
    }
    let fingerprintsOnMultipleAddresses = 0;
    for (const addresses of this.byFingerprint.values()) {
      if (addresses.size > 1) fingerprintsOnMultipleAddresses += 1;
    }
    const trackedAddresses = this.byAddress.size;
    return {
      reports: this.reports,
      reportsWithFingerprint: this.reportsWithFingerprint,
      trackedAddresses,
      addressesWithMultipleFingerprints,
      trackedFingerprints: this.byFingerprint.size,
      fingerprintsOnMultipleAddresses,
      conflictRate:
        trackedAddresses === 0
          ? 0
          : addressesWithMultipleFingerprints / trackedAddresses,
    };
  }

  /** 测试出口：清空状态（模块级/实例级残留会形成隐性顺序依赖）。 */
  reset(): void {
    this.byAddress.clear();
    this.byFingerprint.clear();
    this.reports = 0;
    this.reportsWithFingerprint = 0;
  }

  /** 测试出口：当前跟踪的地址数。 */
  get size(): number {
    return this.byAddress.size;
  }
}

/**
 * 测试出口：新建独立跟踪器（**不使用模块级单例**）。
 *
 * 理由与 `createAddressConflictTracker` 完全相同：register 与 heartbeat 共享
 * 状态的需求，由 `ExecutorService` 持有一个实例字段即可满足（Nest provider
 * 默认单例，两个方法本就跑在同一实例上）；模块级单例会让状态跨测试文件泄漏。
 */
export function createDeviceFingerprintTracker(): DeviceFingerprintTracker {
  return new DeviceFingerprintTracker();
}
