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
 *   同一 address 上出现两个**不同** fingerprint
 *     → 两台不同机器/两份不同安装共用了同一行 = **硬冲突**（零误报：
 *       正常重启不换指纹；盐文件被删后重建才会换，而那本身也是要暴露的事）
 *
 *   同一个 fingerprint 换成另一个 address
 *     → 同一份安装换了地址上报 = **地址漂移**（机器换网/换 IP），属正常，
 *       不是冲突。**必须与硬冲突分开**：把漂移报成冲突会让每次换网都告警。
 *
 * 两个方向各自零误报，这是本模块与 P0 跟踪器的分工——P0 管进程生命，本模块管
 * 安装身份。
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
 */

/** 指纹的合法形态：sha256 的 64 位小写十六进制，与执行器侧同源。 */
export const DEVICE_FINGERPRINT_HEX_LENGTH = 64;

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
   * **硬冲突**：同一 address 上出现了第二个不同指纹。
   *
   * 语义：两台不同机器（或两份不同安装）正在共用同一行 `executors` 记录。
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

interface AddressEntry {
  /** 该地址上出现过的指纹 → 首次出现时刻（Map 保持插入序，用于 FIFO 淘汰）。 */
  fingerprints: Map<string, number>;
  /** 该 (address, fingerprint) 最近一次告警时刻，用于节流。 */
  lastAlertAt: Map<string, number>;
  /** 最近一次上报时刻（惰性 TTL 依据）。 */
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
    this.reports += 1;
    const normalized = normalizeDeviceFingerprint(fingerprint);
    if (!normalized || !address) return null;
    this.reportsWithFingerprint += 1;

    this.sweepExpired(now);

    const isNewAddress = !this.byAddress.has(address);
    if (isNewAddress) this.evictIfFull(now);

    const addressEntry = this.byAddress.get(address) ?? {
      fingerprints: new Map<string, number>(),
      lastAlertAt: new Map<string, number>(),
      updatedAt: now,
    };
    this.byAddress.set(address, addressEntry);
    addressEntry.updatedAt = now;

    const isNewFingerprintOnAddress =
      !addressEntry.fingerprints.has(normalized);
    if (isNewFingerprintOnAddress) {
      addressEntry.fingerprints.set(normalized, now);
      // 有界：FIFO 淘汰最旧的指纹（Map 保持插入序）。
      while (addressEntry.fingerprints.size > MAX_FINGERPRINTS_PER_ADDRESS) {
        const oldest = addressEntry.fingerprints.keys().next().value;
        if (oldest === undefined) break;
        addressEntry.fingerprints.delete(oldest);
        addressEntry.lastAlertAt.delete(oldest);
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

    // 硬冲突判据：该地址上**除本次之外**还有别的指纹。
    // 注意用地址表（而非"是否是本次新增"）判——同一对冲突在被反复上报时
    // 必须持续为 true（否则第二次心跳就"痊愈"了，与 P0 的持续可检出语义不一致）。
    const fingerprintsOnAddress = addressEntry.fingerprints.size;
    const addressSharedByMultipleInstalls = fingerprintsOnAddress > 1;

    let throttled = false;
    if (addressSharedByMultipleInstalls) {
      throttled = this.isAlertThrottled(addressEntry, normalized, now);
    }

    return {
      fingerprint: normalized,
      address,
      fingerprintsOnAddress,
      distinctFingerprintsOnAddress: [...addressEntry.fingerprints.keys()],
      addressesForFingerprint: fingerprintAddresses.size,
      addressSharedByMultipleInstalls,
      // 漂移 = 本次给该指纹**新添**了一个地址（正是「机器换网/换 IP」那一刻）。
      // 刻意不让 `isNewAddress` 参与判定：换网场景下**新地址本身就是新地址**，
      // 若要求「该地址此前见过」才判漂移，恰好会把唯一的漂移时刻漏掉。
      // 也不用 `addressesForFingerprint > 1`——那是「曾经漂移过」的稳定属性而非
      // 本次事件，持续为真会让调用方每次心跳都记一条，日志没有信息量。
      addressDrifted:
        isNewAddressForFingerprint && fingerprintAddresses.size > 1,
      throttled,
    };
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
    const last = entry.lastAlertAt.get(fingerprint);
    if (last !== undefined && now - last < FINGERPRINT_ALERT_THROTTLE_MS) {
      return true;
    }
    entry.lastAlertAt.set(fingerprint, now);
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
