/**
 * ARCH-34 P0（生产事故 2026-09-23）：`address` 冲突检测的单一事实源。
 *
 * 背景：`executors` 表的唯一约束建在 `address` 上（`uq_executors_address`），
 * 而 `address` 是执行器**自报**的（`EXECUTOR_ADDRESS_PUBLIC || EXECUTOR_ADDRESS`），
 * 桌面端默认取局域网 IP + 8002（`pickPublicAddress` 的网卡兜底）。两台不同内网
 * 的机器只要网段相同（`192.168.1.100:8002` 极常见）就会命中**同一行**，后果：
 *   1. 注册互相覆盖（appName/capabilities/startupId 被改写，两台共享 id 与 tokenHash）；
 *   2. pull 队列被共享（`acf:pull:{executorId}` / `acf:cmd:{executorId}`）——
 *      两台机器长轮询同一条 Redis 队列，谁先 RPOP 谁执行，**部署与任务都会串台**；
 *   3. 重启恢复互相误杀（`hasExecutorRestarted` 比对 startupId，交替注册使
 *      `didRestart` 反复为真，把对方正在跑的任务判成 EXECUTOR_RESTART）；
 *   4. token 轮换战（`sameProcess=false` → 每次注册都 rotateToken，互相吊销）。
 *
 * 本模块只做**检测与可见性**，不改写任何注册/调度语义——P0 的目标是让静默串台
 * 变成一条可告警的事实，止血动作（拒绝注册）由调用方按开关决定。
 *
 * ---------------------------------------------------------------------------
 * 判据：为什么是「被顶替的进程生命复活」而不是「同一 address 出现不同 startupId」
 *
 * `startupId` 是**每进程随机 UUID**（`apps/executor-node/src/startup-identity.ts`），
 * 真实重启必然产生一个全新值，**永远不会复用旧值**。因此：
 *
 *   - 「同一 address 出现不同 startupId」**不能**判为冲突——正常的执行器重启
 *     就是这个形状（旧进程死掉、新进程用新 id 注册）。把它当冲突会造成每次
 *     重启都误报，告警很快被忽略（狼来了）。
 *   - 「**曾经被顶替掉的** startupId 又回来上报」才是零误报的冲突信号：那个
 *     进程生命本该已经死了，它还能上报只能说明**它仍然活着**——即同一 address
 *     上有两个活进程在争用同一行。
 *
 * 时序（A、B 两台机器，同 address）：
 *   ① A register startupId=a  → current=a
 *   ② B register startupId=b  → current=b，a 进入 displaced
 *   ③ A heartbeat startupId=a → a ∈ displaced → **冲突**（A 还活着）
 *
 * ③ 是唯一触发点，且只在两台**同时在线**时出现——正是会造成串台的场景。
 *
 * ---------------------------------------------------------------------------
 * 纪律（与仓库既有 util 一致）：
 * - **纯内存、零依赖、零 IO**：在 register/heartbeat 热路径上被调用，
 *   不得引入 DB/网络往返（对齐 `interpreter-match.util.ts` / `version-compare.util.ts`）。
 * - **有界**：地址表与每地址 displaced 表都有上限，超限按最旧淘汰；
 *   惰性 TTL 清扫，不引入定时器（对齐 `tokenValidationCache` 的 MAX+TTL 先例）。
 * - **旧执行器零影响**：`startupId` 缺省（null/undefined）时不登记、不判定、
 *   不告警——存量未上报该字段的执行器行为与引入本特性前逐字节一致。
 */

/** 触发冲突时给出的完整观测结果（供调用方写日志/通知/审计）。 */
export interface AddressConflictObservation {
  /** 同一 address 上检测到两个并存进程生命（被顶替者仍活着）。 */
  conflict: boolean;
  /** 本次上报的 startupId。 */
  startupId: string;
  /** 本次上报顶掉的、原先登记的进程生命（无则为 null）。 */
  displacedStartupId: string | null;
  /** 该 address 上登记过的其他进程生命个数（含被顶替者）。 */
  otherStartupIds: number;
  /**
   * 本次是否因节流而未应告警。
   * 语义：`conflict=true && throttled=true` = 确实冲突，但同一
   * (address, startupId) 组合刚告警过，调用方应跳过外发只记 debug。
   */
  throttled: boolean;
}

/** 每地址最多记住多少个被顶替的进程生命（FIFO 淘汰最旧）。 */
export const MAX_DISPLACED_PER_ADDRESS = 16;

/** 地址表上限（与 tokenValidationCache 的 TOKEN_CACHE_MAX 同量级）。 */
export const MAX_TRACKED_ADDRESSES = 5000;

/** 条目 TTL：超过该时长未再上报的地址被惰性清除（24h）。 */
export const ADDRESS_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

/** 同一 (address, startupId) 组合的告警节流窗口（10min）。 */
export const CONFLICT_ALERT_THROTTLE_MS = 10 * 60 * 1000;

interface AddressEntry {
  /** 最近一次上报的进程生命（= 当前"持有"该 address 的进程）。 */
  current: string | null;
  /**
   * 被顶替过的进程生命 → 被顶替时刻。
   *
   * 为什么需要整张表而不是只记上一个：三方及以上争用（A、B、C 轮流注册）时，
   * 只记"上一个"会让 A 的复活在 B→C 顶替后被遗忘，漏报。表有界即可。
   */
  displaced: Map<string, number>;
  /** 该 (address, startupId) 最近一次告警时刻，用于节流。 */
  lastAlertAt: Map<string, number>;
  /** 最近一次上报时刻（惰性 TTL 依据）。 */
  updatedAt: number;
}

/**
 * `address` 冲突跟踪器。**非线程安全但单线程安全**——admin-api 是单进程事件
 * 循环模型；多副本部署下各副本独立观察，漏报由告警面（任一副本命中即发）
 * 而非状态面承担，与 `tokenValidationCache` 等既有进程内缓存同语义。
 */
export class ExecutorAddressConflictTracker {
  private readonly entries = new Map<string, AddressEntry>();

  /**
   * 记录一次执行器上报并判定是否构成冲突。
   *
   * @param address   执行器自报地址（身份键）。
   * @param startupId 进程生命标识；null/undefined/空白 → 返回 null（旧执行器，不跟踪）。
   * @param now       当前时刻（可注入，便于测试）。
   * @returns 观测结果；`startupId` 缺省时返回 null。
   */
  observe(
    address: string,
    startupId: string | null | undefined,
    now: number = Date.now(),
  ): AddressConflictObservation | null {
    const sid = typeof startupId === "string" ? startupId.trim() : "";
    // 旧执行器（未上报 startupId）：无法区分"重启"与"并存"，一律不判定——
    // 宁可漏报也不能对存量机队产生任何行为/日志变化（兼容性红线）。
    if (!sid || !address) return null;

    this.sweepExpired(now);

    let entry = this.entries.get(address);
    if (!entry) {
      this.evictIfFull(now);
      entry = {
        current: sid,
        displaced: new Map(),
        lastAlertAt: new Map(),
        updatedAt: now,
      };
      this.entries.set(address, entry);
      return {
        conflict: false,
        startupId: sid,
        displacedStartupId: null,
        otherStartupIds: 0,
        throttled: false,
      };
    }

    entry.updatedAt = now;

    // 稳态：同一个进程生命重复上报（30s 心跳的主路径）。零分配早退。
    if (entry.current === sid) {
      return {
        conflict: false,
        startupId: sid,
        displacedStartupId: null,
        otherStartupIds: entry.displaced.size,
        throttled: false,
      };
    }

    // 本次上报的进程生命**曾经被顶替过** → 它本该已死却仍在说话 = 并存。
    if (entry.displaced.has(sid)) {
      const throttled = this.isAlertThrottled(entry, sid, now);
      return {
        conflict: true,
        startupId: sid,
        displacedStartupId: entry.current,
        otherStartupIds: entry.displaced.size + (entry.current ? 1 : 0),
        throttled,
      };
    }

    // 正常接管（首次注册 / 真实重启）：顶掉当前者并登记，**不**判为冲突。
    const previous = entry.current;
    if (previous) {
      entry.displaced.set(previous, now);
      // 有界：FIFO 淘汰最旧的被顶替者（Map 保持插入序）。
      while (entry.displaced.size > MAX_DISPLACED_PER_ADDRESS) {
        const oldest = entry.displaced.keys().next().value;
        if (oldest === undefined) break;
        entry.displaced.delete(oldest);
        entry.lastAlertAt.delete(oldest);
      }
    }
    entry.current = sid;
    return {
      conflict: false,
      startupId: sid,
      displacedStartupId: previous,
      otherStartupIds: entry.displaced.size,
      throttled: false,
    };
  }

  /**
   * 节流判定：同一 (address, startupId) 在窗口内只应告警一次。
   * 命中即**记录本次告警时刻**（调用方据此外发一次）。
   */
  private isAlertThrottled(
    entry: AddressEntry,
    startupId: string,
    now: number,
  ): boolean {
    const last = entry.lastAlertAt.get(startupId);
    if (last !== undefined && now - last < CONFLICT_ALERT_THROTTLE_MS) {
      return true;
    }
    entry.lastAlertAt.set(startupId, now);
    return false;
  }

  /** 惰性 TTL 清扫：只清理确实过期的条目，避免长跑进程内存无界。 */
  private sweepExpired(now: number): void {
    if (this.entries.size === 0) return;
    for (const [address, entry] of this.entries) {
      if (now - entry.updatedAt > ADDRESS_ENTRY_TTL_MS) {
        this.entries.delete(address);
      }
    }
  }

  /** 地址表满时淘汰最久未更新的条目（O(n) 但仅在满表时触发，n ≤ 5000）。 */
  private evictIfFull(now: number): void {
    if (this.entries.size < MAX_TRACKED_ADDRESSES) return;
    this.sweepExpired(now);
    if (this.entries.size < MAX_TRACKED_ADDRESSES) return;
    let oldestAddress: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [address, entry] of this.entries) {
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestAddress = address;
      }
    }
    if (oldestAddress !== null) this.entries.delete(oldestAddress);
  }

  /** 测试出口：清空状态（模块级/实例级残留会形成隐性顺序依赖）。 */
  reset(): void {
    this.entries.clear();
  }

  /** 测试出口：当前跟踪的地址数。 */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * 测试出口：新建独立跟踪器（**不使用模块级单例**）。
 *
 * 为什么是实例而非模块级单例：register 与 heartbeat 共享状态的需求，由
 * `ExecutorService` 持有一个实例字段即可满足（Nest provider 默认单例，
 * 两个方法本就跑在同一实例上）。模块级单例会让状态**跨测试文件泄漏**——
 * 仓库已有前科（见 `__resetTruncationWarnStateForTest` 的注释：模块级 Map
 * 跨测试残留会形成隐性顺序依赖）。实例字段天然隔离。
 */
export function createAddressConflictTracker(): ExecutorAddressConflictTracker {
  return new ExecutorAddressConflictTracker();
}
