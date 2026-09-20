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
  // NOTE（合流收口）：当前 TypeORM 版本的 @Index options 类型不收 using，
  // 用 as any 仅为通过类型检查；GIN 索引的真实 DDL 需由对应迁移落库。
  // NETOPT-F P3-4: **死索引确认**——全仓无 `@>` 包含查询（调度侧匹配走
  // 内存 interpreterSatisfies 纯函数，心跳全量重写整列），GIN 只付维护成本。
  // 预防性占位：若未来调度把"解释器匹配"下推 SQL 再启用；否则可作 drop 候选
  // （本轮不动 DDL，避免无谓迁移）。
  @Index("idx_executors_interpreters", { using: "gin" } as any)
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
