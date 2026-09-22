import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
} from "typeorm";
// python_task_multiversion（WS2）：解释器缓存池清单条目形状（纯接口，非 TS enum
// ——刻意不引 enum，避免污染 check-enum-drift 的枚举面）。
import type { ExecutorInterpreter } from "../interpreter-match.util";

export enum ExecutorStatus {
  ONLINE = "online",
  OFFLINE = "offline",
}
/**
 * 遗留 P1-24：离线原因区分。
 * - manual：优雅下线（执行器主动 shutdown / 管理员手动下线）；
 * - stale_timeout：心跳超时被 stale sweep 判死。
 * 仅 status=OFFLINE 时有意义；回到 ONLINE 时置 null。
 */
export enum ExecutorOfflineReason {
  MANUAL = "manual",
  STALE_TIMEOUT = "stale_timeout",
}
export enum ExecutorType {
  PYTHON = "python",
  NODE = "node",
  UNIVERSAL = "universal",
}

@Entity("executors")
@Index(["status"])
@Index(["groupName"])
@Index(["lastHeartbeat"])
@Index("uq_executors_address", ["address"], { unique: true })
export class Executor {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() appName: string;
  @Column() address: string;
  @Column({
    type: "enum",
    enum: ExecutorStatus,
    default: ExecutorStatus.OFFLINE,
  })
  status: ExecutorStatus;
  // 遗留 P1-24：离线原因。null=在线或历史数据未标注。
  @Column({ type: "enum", enum: ExecutorOfflineReason, nullable: true })
  offlineReason: ExecutorOfflineReason | null;

  /**
   * NETOPT-G P1-7（判死迟滞）：连续被判超时的 sweep 轮数。
   *
   * 背景：修复前 `markStaleOffline` 是**单次墙钟判定**——只要一次扫描时
   * `lastHeartbeat < now - 90s` 就立即 ONLINE→OFFLINE。跨境链路上单次心跳
   * 失败率约 4.5%，且长尾 RTT 可达 153s（生产实测），于是"两次相邻失败 +
   * 一次长尾"就会踩线判死。生产当天 10 次判死中只有 1 次（14:09）真由宿主
   * 内核软锁引起，其余 9 次都是链路抖动导致的**误判**——每次误判都会触发
   * 离线通知、把执行器从派发候选里剔除，并让运行中的任务被误标。
   *
   * 语义：sweep 每轮只**递增**该计数，达到 `staleOfflineConfirmations`
   * （默认 2）才真正置 OFFLINE；任一心跳到达即清零（见 heartbeat()）。
   * 计数值 >= 1 说明"已错过至少一轮"，可作为"疑似失联"的观测面。
   *
   * 为什么用列而不是内存 Map：admin-api 多副本部署（leaderGate 选主执行
   * sweep），内存计数会在主从切换后丢失，导致新 leader 从 0 重新开始计数
   * ——判死延迟不可预期。落库后语义跨副本一致。
   */
  @Column({ type: "int", default: 0 })
  consecutiveHeartbeatMisses: number;
  @Column({ type: "enum", enum: ExecutorType, default: ExecutorType.PYTHON })
  type: ExecutorType;
  @Column({ nullable: true }) executorVersion: string;

  /**
   * PROTOCOL-VER（B-3/U-2）：执行器上报的**协议版本**（与实现版本
   * executorVersion 解耦，见 packages/executor-protocol/protocol.json 的
   * `versioning` 段）。由 register 载荷写入，用于中台兼容性分支：
   * protocolVersion < PROTOCOL_SUPPORTED_MIN 时 warn + 按旧协议兜底（不拒
   * 注册——与 EXECUTOR_MIN_VERSION 实现版本门禁是两套闸）。
   * 语义：null = 旧执行器未上报（按 protocolVersion=1 兜底）。
   */
  @Column({ type: "int", nullable: true })
  protocolVersion: number | null;
  /**
   * ARCH-32（ADR-015）：派发模式。'push'（默认）= 中心端向执行器 address 发
   * 入站 POST；'pull' = 执行器长轮询 POST /executors/pull 取任务（NAT 内执行
   * 器零入站依赖）。由执行器 register 上报写入（dispatch() 据此走传输分支）。
   */
  @Column({ type: "varchar", length: 16, default: "push" }) dispatchMode:
    "push" | "pull";
  @Column({ type: "simple-array", nullable: true }) capabilities: string[];
  @Column({ nullable: true }) lastHeartbeat: Date;
  @Column({ nullable: true }) executorStartedAt: Date | null;
  @Column({ nullable: true }) executorStartupId: string | null;
  /**
   * 当前在跑任务数（派发闸门 selectLeastLoaded / 容量守卫直接读它判满）。
   * 心跳白名单采纳域：非负整数 0..10000（与 runningExecutionIds 数组截顶
   * MAX_RUNNING_EXECUTION_IDS 同源）；非法/缺失不改 DB 值（执行器上报面
   * 不可信）。重启恢复（register/heartbeat didRestart）不再批量减槽——计数
   * 权威交给调用方 e.runningTaskCount=0 + save / 心跳自报覆盖（NETOPT-E P2-1）。
   */
  @Column({ type: "int", default: 0 }) runningTaskCount: number;
  @Column({ type: "float", nullable: true }) cpuUsage: number;
  @Column({ type: "float", nullable: true }) memUsage: number;

  /** Extended performance metrics */
  @Column({ type: "float", nullable: true }) diskUsage: number;
  @Column({ type: "float", nullable: true }) networkLatency: number;
  @Column({ type: "int", default: 0 }) totalTaskCount: number;
  @Column({ type: "int", default: 0 }) failedTaskCount: number;

  /** Max concurrent tasks this executor may run simultaneously (null = unlimited). */
  @Column({ type: "int", nullable: true }) maxConcurrentTasks: number | null;

  /**
   * CONSISTENCY-02: executor-node 心跳上报的"当前正在执行的 executionId 列表"
   * （≤10000，与 E9 采纳域 maxConcurrentTasks ≤10000 同源；executor-node
   * scheduler.ts 与 admin-api sanitizeRunningExecutionIds 双侧一致裁剪——NETOPT-C
   * P2-1 把旧 200 封顶提到 10000，实体注释同步，勿再改回旧值）。stale 扫描据此
   * 判断 RUNNING 行是否仍在真实执行——执行器在线且上报集合包含该 executionId 时
   * 跳过本轮误判恢复，避免把回调退避重试/排队导致超阈值的正常执行误杀。
   * 语义：null = 旧版执行器未上报该字段（区别于 []：[] 表示上报了且当前空闲）。
   */
  @Column({ type: "jsonb", nullable: true })
  runningExecutionIds: string[] | null;

  /**
   * U16: executor 心跳上报的 dead-letter 积压数（回调重试死信队列长度）。
   * node 端 ab4971f 起上报、python 端 001 起上报；admin 侧经心跳白名单采纳
   * （非负整数 0..100000，非法/缺失不改 DB 值，与 maxConcurrentTasks 同模式）。
   * 语义：null = 旧版执行器未上报该字段。幂等迁移见
   * migrations/1788900000000-AddExecutorDeadLetterCount.ts。
   */
  @Column({ type: "int", nullable: true }) deadLetterCount: number | null;

  /**
   * python_task_multiversion（WS2）：执行器上报的**解释器缓存池清单**
   * （CONTRACT.md §2.2；迁移 1790000000025-AddExecutorInterpreters）。
   *
   * 三态语义必须可区分（这是调度侧的唯一判据来源）：
   * - `null` = **未上报**（存量旧执行器）→ 调度按 `["3.12"]` 兜底；
   * - `[]`   = 已上报且**缓存池为空** → 无任何版本可满足（**不兜底**）；
   * - `[{version,path,available,discoveredAt}]` = 具体清单（补丁版本，探测所得）。
   *
   * 采纳规则完全对照 `deadLetterCount`：字段 `undefined`（未发送）→ 保留 DB 旧值；
   * 存在但结构非法 → 整字段拒绝采纳 + warn，DB 不动；合法（含 `[]`）→ 覆盖。
   * 结构校验/匹配判据均在 `interpreter-match.util.ts`（纯函数单一事实源）。
   */
  @Column({ type: "jsonb", nullable: true })
  // E-P2-R1：原 GIN 索引 idx_executors_interpreters 已由迁移
  // 1790000000034 DROP——全仓零 `@>` 包含查询（调度侧走内存
  // interpreterSatisfies），死索引只付维护成本。此处不再声明 @Index。
  interpreters: ExecutorInterpreter[] | null;

  /**
   * SEC-03: per-executor token stored as bcrypt hash.
   * Rotated via POST /api/executors/:id/rotate-token.
   */
  @Column({ nullable: true, select: false }) tokenHash: string | null;

  /** Executor group name for logical grouping. */
  @Column({ nullable: true }) groupName: string | null;

  /** Executor tags for flexible filtering and routing. */
  @Column({ type: "simple-array", nullable: true }) tags: string[] | null;

  /** Executor description. */
  @Column({ type: "text", nullable: true }) description: string | null;

  /**
   * AUTH-01（多租户 Project，第一批）：执行器归属项目（可空）。迁移
   * 1790000000009 加列 + FK ON DELETE SET NULL + 索引。存量行不回填——
   * 可空 = 未分配，语义上归默认项目视图。只加列不加关系（执行器注册/
   * 心跳路径不感知项目，调度面后续批次消费）。
   */
  @Column({ type: "uuid", nullable: true })
  projectId: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;

  /** R-P0-006: Optimistic lock version for preventing dispatch race conditions */
  @VersionColumn() version: number;
}
