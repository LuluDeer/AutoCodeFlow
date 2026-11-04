import type { Logger } from "@nestjs/common";
import type { Executor } from "./entities/executor.entity";
import { ExecutorStatus } from "./entities/executor.entity";
import type { ExecutorInterpreter } from "./interpreter-match.util";
import {
  normalizeInterpreters,
} from "./interpreter-match.util";
import { normalizeInstalledPackages } from "./deployed-apps.util";
import type { InstalledPackageReport } from "./deployed-apps.util";
import { normalizeDeviceFingerprint } from "./executor-fingerprint.util";

/**
 * T1-B3c：`heartbeat` 的**上报值校验 + 采纳 + patch 投影**协作者。
 *
 * ## 边界：只搬「读/判定与纯计算」，**副作用全部留 Facade**
 *
 * 本类只做三件事，全部**无 IO**（除 `logger.warn/debug`）：
 *   ① 指标白名单与取值范围校验（非法值 ⇒ 从 metricValues 删除、DB 值不动）；
 *   ② 把通过校验的值**就地写进实体** `e`，并登记 `adopted`（采纳集）；
 *   ③ 三态字段的结构校验（`interpreters` / `installedPackages` /
 *      `deviceFingerprint` / `taskSandbox`）。
 *
 * **留在 Facade 的副作用**（本类一概不碰）：
 *   · `repo.update({id}, patch)` —— 唯一写；
 *   · `applyReportedAppVersions(...)` —— 其内部**自有事务**（`dataSource.transaction`）；
 *   · `emitExecutorOnline(...)` —— 领域事件；
 *   · `metricsHistoryRepo.save(...)` —— 指标快照；
 *   · `pickOwnedColumns(...)` + `HEARTBEAT_OWNED_COLUMNS` —— 列级投影（register 路径也用它）。
 *
 * ## ⚠️ 依赖注入纪律：**禁止 import Facade**
 *
 * 本类是**普通 TS 类**（不是 Nest provider）⇒ 需要 Facade 的成员时一律**构造注入**，
 * **绝不** `import { ExecutorService }` 反向引用 Facade —— 那会构成
 * Facade↔协作者**循环 import**（且把「谁依赖谁」这条边界打穿）。
 *
 * 同理：`ExecutorService.xxx` 这类 private static **不能**在协作者里引用；
 * 单用途的判定函数已**随迁**到本类（见下方 `isAdoptableDeadLetterCount` /
 * `isAdoptableReservedSlots`），多用途的经 `deps` 注入（见
 * `isAdoptableMaxConcurrentTasks` / `sanitizeRunningExecutionIds`）。
 *
 * ## 为什么 `sanitizeRunningExecutionIds` 留在 Facade
 *
 * 它依赖**模块级节流 Map** `lastTruncationWarn`，而该 Map 被
 * `__resetTruncationWarnStateForTest()` 导出给 spec 重置
 * （`executor.service.spec.ts:17/2546`）。搬走会把「节流状态」与「重置出口」分家
 * ⇒ 该测试出口失效。**宁可少搬**：经 `deps.sanitizeRunningExecutionIds` 回调。
 */

/** 心跳可写指标列（与 Facade 的 `metricsWhitelist` 同集合）。 */
export type HeartbeatMetricValues = Partial<
  Pick<
    Executor,
    | "cpuUsage"
    | "memUsage"
    | "diskUsage"
    | "networkLatency"
    | "runningTaskCount"
    | "totalTaskCount"
    | "failedTaskCount"
    | "maxConcurrentTasks"
    | "deadLetterCount"
  >
>;

/** 心跳采纳列（Facade 的 `HeartbeatOwnedColumn` 联合）。 */
export type HeartbeatOwnedColumn = Parameters<
  // 只用其成员名，不引入 Facade 类型
  never
> extends never
  ? string
  : string;

/** 协作者依赖（全部最小面）。 */
export interface ExecutorHeartbeatReportDeps {
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
  /** Facade 的 private static（3 处用量：register / heartbeat / 另一路径）。 */
  isAdoptableMaxConcurrentTasks: (value: unknown) => boolean;
  /**
   * Facade 的 `sanitizeRunningExecutionIds`（依赖模块级节流 Map 与
   * `__resetTruncationWarnStateForTest` 重置出口 ⇒ 不随迁）。
   */
  sanitizeRunningExecutionIds: (
    value: unknown,
    address?: string,
  ) => string[] | null;
  /**
   * 运行中执行 id 的采纳上界（Facade 的模块级 const，**不随迁**：
   * `executor-constants.ts:117` 记录了搬走会让对应 spec 的文本断言失配）。
   */
  maxRunningExecutionIds: number;
}

export class ExecutorHeartbeatReport {
  private readonly logger: Logger;
  private readonly deps: ExecutorHeartbeatReportDeps;

  constructor(deps: ExecutorHeartbeatReportDeps) {
    this.logger = deps.logger;
    this.deps = deps;
  }

  /** `value` 是否为本心跳可采纳的 dead-letter 计数（0..100000 整数）。 */
  private isAdoptableDeadLetterCount(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 100_000
    );
  }

  /** `value` 是否为本心跳可采纳的 reservedSlots（非负整数）。 */
  private isAdoptableReservedSlots(value: unknown): value is number {
    return (
      typeof value === "number" && Number.isInteger(value) && value >= 0
    );
  }

  /**
   * 校验 + 就地采纳 + 返回「心跳前是否在线」。
   *
   * 返回值 `wasOnline` 供 Facade 判定**在线跃迁**（只在真实跃迁时发
   * `executor.online` 事件；心跳 30s 一次，无条件 emit 会把 outbox 打爆）。
   */
  applyReportedMetrics(args: {
    executor: Executor;
    address: string;
    /** 仅用 `deviceFingerprint` 的「是否上报」判定。 */
    metrics: { deviceFingerprint?: string | null };
    metricValues: HeartbeatMetricValues;
    adopted: Set<HeartbeatOwnedColumn>;
    incomingStartedAt: Date | null;
    incomingStartupId: string | null;
    incomingFingerprint: string | null;
    runningExecutionIds: string[] | null | undefined;
    reservedSlots: number | null | undefined;
    interpreters: ExecutorInterpreter[] | null | undefined;
    installedPackages: InstalledPackageReport[] | null | undefined;
    taskSandbox: string | null | undefined;
  }): { wasOnline: boolean } {
    const {
      executor: e,
      address,
      metrics,
      metricValues,
      adopted,
      incomingStartedAt,
      incomingStartupId,
      incomingFingerprint,
      runningExecutionIds,
      reservedSlots,
      interpreters,
      installedPackages,
      taskSandbox,
    } = args;

    const metricsWhitelist: Array<
      | "cpuUsage"
      | "memUsage"
      | "diskUsage"
      | "networkLatency"
      | "runningTaskCount"
      | "totalTaskCount"
      | "failedTaskCount"
      | "maxConcurrentTasks"
      | "deadLetterCount"
    > = [
      "cpuUsage",
      "memUsage",
      "diskUsage",
      "networkLatency",
      "runningTaskCount",
      "totalTaskCount",
      "failedTaskCount",
      "maxConcurrentTasks",
      "deadLetterCount",
    ];
    if (
      metricValues.maxConcurrentTasks !== undefined &&
      !this.deps.isAdoptableMaxConcurrentTasks(
        metricValues.maxConcurrentTasks,
      )
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid maxConcurrentTasks=${String(
          metricValues.maxConcurrentTasks,
        )} (expected integer in 1..10000); keeping stored value`,
      );
      delete metricValues.maxConcurrentTasks;
    }
    // NETOPT-D P2-D2: runningTaskCount 是派发闸门的数字列（selectLeastLoaded/
    // 容量守卫直接读它判满）——执行器上报面不可信，必须与数组截顶共享同一
    // 上界（this.deps.maxRunningExecutionIds）。否则真实在跑 >10000 时闸门误判有空位
    // 而超发；且被数组截断丢弃的 id 在 stale includes() 判据里被判"不在跑"，
    // 健康长任务被提前恢复成 FAILED。非法值视同未上报（DB 值不动）。
    if (
      metricValues.runningTaskCount !== undefined &&
      (!Number.isInteger(metricValues.runningTaskCount) ||
        metricValues.runningTaskCount < 0 ||
        metricValues.runningTaskCount > this.deps.maxRunningExecutionIds)
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid runningTaskCount=${String(
          metricValues.runningTaskCount,
        )} (expected integer in 0..${this.deps.maxRunningExecutionIds}); keeping stored value`,
      );
      // NETOPT-E P3-1: 越界只删字段、DB 值不动——持续越界上报期间派发闸门用
      // 陈旧计数判满（可能误判满/空），但下一次合法上报即自纠正；不为此引入
      // 半采纳状态（半采纳值同样不可信）。
      delete metricValues.runningTaskCount;
    }
    // U16: deadLetterCount 采纳（node ab4971f / python 001 起上报）。非法值
    // 视同未上报——从 metricValues 删除，DB 值不动，与上轮 maxConcurrentTasks
    // 采纳同模式。
    if (
      metricValues.deadLetterCount !== undefined &&
      !this.isAdoptableDeadLetterCount(metricValues.deadLetterCount)
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid deadLetterCount=${String(
          metricValues.deadLetterCount,
        )} (expected integer in 0..100000); keeping stored value`,
      );
      delete metricValues.deadLetterCount;
    }
    // A-6（执行器域审计 P3）：cpuUsage/memUsage 是评分公式的直接输入
    // （computeExecutorLoadScore 按 /100 归一到 [0,1]）——越界值会把评分推出
    // 量纲（负值 → 负分，>100 → cpu/mem 项越过权重上限），且该输入每 30s 心跳
    // 刷新一次。执行器自报面不可信：越界/非有限值视同**未上报**（删字段、
    // DB 值不动），与上方 maxConcurrentTasks / runningTaskCount 的非法采纳
    // 先例同策。
    for (const pctKey of ["cpuUsage", "memUsage"] as const) {
      const pctValue = metricValues[pctKey];
      if (
        pctValue !== undefined &&
        (!Number.isFinite(pctValue) || pctValue < 0 || pctValue > 100)
      ) {
        this.logger.warn(
          `Executor ${address} reported invalid ${pctKey}=${String(pctValue)} (expected a number in 0..100); treating as not reported`,
        );
        delete metricValues[pctKey];
      }
    }
    // metricsWhitelist 的键全部对应 Executor 的数值指标列（Pick<Executor, …>
    // 为纯上转型断言）——写入经由该视图而非 `(e as any)`，保持类型面精确；
    // 运行时行为与原逐键直写完全一致。
    const writableMetrics = e as Pick<
      Executor,
      (typeof metricsWhitelist)[number]
    >;
    for (const key of metricsWhitelist) {
      if (metricValues[key] !== undefined) {
        writableMetrics[key] = metricValues[key];
        // R53-A1：只有**本轮真的上报且通过校验**的指标才进 patch。未上报的
        // 指标不写（此前整行 save 会把快照值写回，双主人列 maxConcurrentTasks
        // 因此会把管理台刚改的容量顶掉）。
        adopted.add(key);
      }
    }
    // NETOPT-G P1-6：记录跃迁前的状态——executor.online 只在**真实恢复**
    // （非 ONLINE → ONLINE）时发布，避免每次 30s 心跳都刷一条事件。
    const wasOnline = e.status === ExecutorStatus.ONLINE;
    // ⚠️ 方案 b：下面四行的内存赋值**无条件执行**（最小 diff），但抑制路径
    // （suppressLivenessAdoption）下这四列不在 adopted 里 → 不进 patch →
    // **不落库**。因此返回体 saved = {...e, ...patch} 的 status/lastHeartbeat
    // 是内存态（ONLINE/now），与 DB 的权威状态（保持心跳前值）表面不一致
    // ——以 **DB 为准**：消费者（sweep/接管窗/派发闸门）全部读库；响应体只
    // 回给执行器（仅消费 tokenHash/versionCompliant，不读状态列）。
    // emitExecutorOnline 同步抑制（下方）——DB 没有点亮 ONLINE，事件绝不外发。
    e.status = ExecutorStatus.ONLINE;
    // NETOPT-G P1-7：心跳到达即清零"连续超时"计数——这是迟滞判死能自愈的
    // 关键：一次成功心跳就把"疑似失联"状态彻底解除，下一轮 sweep 必须重新
    // 从 0 累计，因此"偶发失败 + 恢复"永远不会累积到判死阈值。
    // （方案 b 抑制路径不落库：冲突自报心跳同样不清零计数器。）
    e.consecutiveHeartbeatMisses = 0;
    // 遗留 P1-24：恢复在线即清除离线原因标注。
    e.offlineReason = null;
    e.lastHeartbeat = new Date();
    if (incomingStartedAt) {
      e.executorStartedAt = incomingStartedAt;
      adopted.add("executorStartedAt");
    }
    if (incomingStartupId) {
      e.executorStartupId = incomingStartupId;
      adopted.add("executorStartupId");
    }

    // CONSISTENCY-02: persist executor-node 的活性上报。缺省字段写 null
    // （= 旧版执行器未上报，区别于 [] 的"已上报且空闲"）；仅在字段上报时才
    // 覆盖，避免旧版心跳把新版已写入的活性集合擦回 null。deadLetterCount
    // 经上方白名单校验后采纳落列（U16），>0 时仍保留告警。
    if (runningExecutionIds !== undefined) {
      e.runningExecutionIds = this.deps.sanitizeRunningExecutionIds(
        runningExecutionIds,
        address,
      );
      adopted.add("runningExecutionIds");
    }
    // E-01-RPT（生产实证：RPA5 恒显「当前运行任务 1/10」「活性上报 0 条，与运行
    // 计数 1 不一致」，而设备上无任务在跑）：采纳 pull 预留槽位数。
    //
    // 采纳时机刻意放在**这里**：此刻 e.runningTaskCount 已被上方白名单环写成
    // 本次上报的最终值（或重启分支清零值），配对校验才拿得到真值。
    //
    // 三态纪律（与 runningExecutionIds 同款，这是兼容性红线）：
    // - `undefined`（旧版执行器未上报）→ **保留 DB 旧值**，UI 回落「按已占槽位
    //   显示」的旧口径，行为与引入前逐字节一致；
    // - 非法（非整数/负数/超上界/与 runningTaskCount 不自洽）→ warn + 保留 DB
    //   旧值（不半采纳——半采纳值同样不可信，与 NETOPT-E P3-1 同调）；
    // - 合法（**含 0**）→ 覆盖。
    //
    // 自洽性硬约束 `reservedSlots <= runningTaskCount`：预留是「已占槽位」的
    // **子集**（E-01 让预留与正式占用共用同一账本），故预留数不可能超过总数。
    // 违反即说明该上报不可信（典型成因：本次 runningTaskCount 越界被删、留下
    // 陈旧低值），此时连 reservedSlots 一起拒绝，让 UI 走旧口径，下一次合法
    // 上报即自纠正。
    if (reservedSlots !== undefined) {
      if (!this.isAdoptableReservedSlots(reservedSlots)) {
        this.logger.warn(
          `Executor ${address} reported invalid reservedSlots=${String(
            reservedSlots,
          )} (expected integer in 0..${this.deps.maxRunningExecutionIds}); keeping stored value`,
        );
      } else if (reservedSlots > e.runningTaskCount) {
        // 注意用 e.runningTaskCount（最终值）而非 metricValues.runningTaskCount
        // ——后者可能刚被越界校验删除，读它会是 undefined 而恒判不自洽。
        this.logger.warn(
          `Executor ${address} reported reservedSlots=${reservedSlots} exceeding ` +
            `runningTaskCount=${e.runningTaskCount} (reservations are a subset of ` +
            `occupied slots); keeping stored reservedSlots`,
        );
      } else {
        e.reservedSlots = reservedSlots;
        adopted.add("reservedSlots");
      }
    }
    // python_task_multiversion（WS2 · CONTRACT §2.2/§2.3 · 兼容性红线 3）：
    // 心跳采纳 `interpreters`——三态必须精确区分，任一态混淆都会造成调度错判：
    // - 字段 `undefined`（旧执行器心跳 / 新版未变化时不上报）→ **保留 DB 旧值**。
    //   这是红线 3 的字面要求：旧心跳绝不能把已上报的清单清空（清空后该执行器
    //   会被当成"池空"而彻底接不到带版本声明的任务）。
    // - 存在但结构非法（非数组 / 项缺 version / version 非 X.Y|X.Y.Z）→ 整字段
    //   拒绝采纳 + warn，DB 保留旧值（脏上报不得污染调度判据）。
    // - 合法（**含 `[]`**，"已上报且缓存池为空"）→ 覆盖。
    if (interpreters !== undefined) {
      const normalizedInterpreters = normalizeInterpreters(interpreters);
      if (normalizedInterpreters === null) {
        this.logger.warn(
          `Executor ${address} reported an invalid interpreters payload ` +
            `(expected an array of { version: "X.Y" | "X.Y.Z" }); keeping stored value`,
        );
      } else {
        e.interpreters = normalizedInterpreters;
        adopted.add("interpreters");
      }
    }
    // R3-A（§4.3/P10）：心跳采纳 `installedPackages`——三态与 interpreters
    // 完全同款（缺省 → 保留 DB 旧值；结构非法 → 整字段拒绝 + warn；
    // 合法含 [] → 覆盖「已上报且无安装包」）。executors 列白名单已登记
    // （HEARTBEAT_OWNED_COLUMNS），patch 投影由 adopted 集合把关。
    if (installedPackages !== undefined) {
      const normalizedInstalledPackages =
        normalizeInstalledPackages(installedPackages);
      if (normalizedInstalledPackages === null) {
        this.logger.warn(
          `Executor ${address} reported an invalid installedPackages payload ` +
            `(expected an array of { name, type, version }); keeping stored value`,
        );
      } else {
        e.installedPackages = normalizedInstalledPackages;
        adopted.add("installedPackages");
      }
    }
    // ARCH-36（ADR-017 阶段 2）：心跳采纳 `deviceFingerprint`。
    // 三态与 interpreters 同款，但**非法时只留 debug 不 warn**：指纹是机器
    // 自报的十六进制串，形态非法说明执行器侧采集/序列化有 bug，而这条路径
    // 每 30s 一次/台——warn 会给全部异常执行器刷屏，debug 已足够定位（真正的
    // 可观测价值在 `stats()` 的覆盖率口径：reportsWithFingerprint / reports）。
    // 关键：缺省/非法一律**不动 DB**——绝不让旧执行器或采集失败的心跳把已存的
    // 指纹擦成 NULL（那会让冲突观测失去历史，正是本阶段最需要的数据）。
    if (metrics.deviceFingerprint !== undefined) {
      if (incomingFingerprint === null) {
        this.logger.debug(
          `Executor ${address} reported a non-conformant deviceFingerprint ` +
            `(expected 64 hex chars); keeping stored value`,
        );
      } else {
        // P1-2（ADR-017 阶段 3 复查补口）：**绝不覆盖别人那行的真实指纹**。
        //
        // 行是按地址回落的（按指纹查不到本行），而本行已存着**另一份**安装的
        // 真实指纹 ⇒ 这是另一份安装在同址心跳。旧实现直接把本次指纹写进这一行：
        // DHCP 把同一 IP 先后分给两台机器时（现场 17:33/17:34 实证），两台机器
        // 会每 30s 互改同一行的指纹，行身份在两份安装之间来回漂移——注册面刚
        // 裁定的归属被心跳面悄悄推翻，冲突观测也失去历史。
        //
        // 现在：不采纳（不写该列），身份留在自己的行上；真正的碰撞由
        // observeDeviceFingerprint 的 row-identity-overwrite 判据以 ERROR +
        // 通知外发（可见、可处置），而不是靠静默改字段"自愈"。
        // 只 debug 不 warn：心跳 30s 一台，warn 会刷屏，而 ERROR 侧已覆盖可见性。
        // 存量 legacy/NULL 行（storedReal === null）不受影响——升级接管仍照旧。
        const storedReal = normalizeDeviceFingerprint(e.deviceFingerprint);
        if (storedReal !== null && storedReal !== incomingFingerprint) {
          this.logger.debug(
            `Heartbeat from ${address} carried deviceFingerprint ` +
              `${incomingFingerprint.slice(0, 12)}… but row ${e.id} belongs to ` +
              `${storedReal.slice(0, 12)}… — not adopting: a different install is sharing this ` +
              `address, so the fingerprint stays with its owner (the deviceFingerprint conflict ` +
              `observer reports the collision)`,
          );
        } else {
          e.deviceFingerprint = incomingFingerprint;
          adopted.add("deviceFingerprint");
        }
      }
    }
    // S4-C4（协议 v9，沙箱姿态在控制面可见）：心跳采纳 `taskSandbox`——
    // 「那台机器上的 TASK_SANDBOX 到底开没开」。三态纪律**必须精确区分**，
    // 这是本项的全部价值所在（塌成两态就退回「看不出来」的原状）：
    // - 字段 `undefined`（旧执行器未发送 / 从未升级）→ **保留 DB 旧值**（NULL
    //   或上一轮上报值）。这是兼容性红线：升级期新旧执行器并存，旧心跳绝不能
    //   把一台已上报「bwrap」的机器擦成「未上报」。
    // - 非法值（不是恰好 '' 或 'bwrap'：'off' / 'true' / 'docker' / 'BWRAP' /
    //   数字 / null …）→ warn + 保留 DB 旧值，**按「未上报」处理**（fail-safe：
    //   宁可让读面显示「不知道」，也不把非法值猜成直跑或沙箱——猜成直跑会
    //   制造一条假的安全结论，猜成沙箱会隐瞒一个真缺口，两种方向都不可接受）。
    // - 合法（**含 ''**）→ 覆盖。`''` 是「已上报且直跑」这个**真值**，与「未
    //   上报」（列 NULL）在语义上完全不同，读面必须能区分。
    //
    // 注意这里不需要「与 runningTaskCount 配对」之类的自洽校验：姿态是单一
    // 枚举值，没有可矛盾的第二个量。
    if (taskSandbox !== undefined) {
      if (taskSandbox === "" || taskSandbox === "bwrap") {
        e.taskSandbox = taskSandbox;
        adopted.add("taskSandbox");
      } else {
        this.logger.warn(
          `Executor ${address} reported invalid taskSandbox=${JSON.stringify(
            taskSandbox,
          )} (expected '' or 'bwrap'); treating as not reported (keeping stored value)`,
        );
      }
    }
    if (
      typeof metricValues.deadLetterCount === "number" &&
      Number.isFinite(metricValues.deadLetterCount) &&
      metricValues.deadLetterCount > 0
    ) {
      this.logger.warn(
        `Executor ${address} reported ${metricValues.deadLetterCount} dead-letter execution(s) awaiting callback retries`,
      );
    }

    // R53-A1（ADR-026 规则 4）：这里此前是 `repo.save(e)` **整行回写**。
    // 缺陷（上一轮 R51-A1 登记）：save 是「读当前行 → 按列 diff → 只写差异列」，
    // 快照里那些**心跳从不修改**、却由 register / 管理台拥有的列，只要在
    // findOne 之后被改过，就会被 diff 判成"改动"按旧值写回。受害列：
    // address / appName / capabilities / groupName / tags / description /
    // maxConcurrentTasks / dispatchMode / protocolVersion / executorVersion。
    // 而心跳**永不自纠正**这些列 —— 管理台每改一次就被回弹一次，且一直错到
    // 下一次 register。原注释只为 runningTaskCount 的 ±1 偏差辩护（"下一心跳
    // 自纠正"），从未辩护过上面这批。
    //
    // NETOPT-F P3-3（读改写竞态，仅文档化，语义不变）：本 patch 仍可覆盖
    // dispatch 的原子 +1 与 stale sweep 的原子 -1——每事件至多 1 槽偏差，且
    // 下一心跳（执行器如实上报 runningTaskCount）即自纠正。不加锁/版本校验
    // 是有意取舍（R-P0-006：心跳高频、乐观锁冲突会反噬吞吐）；偏差窗口内的
    // 闸门判满/判空是暂时的，不上报的旧版执行器才依赖该近似。
    return { wasOnline };
  }
}
