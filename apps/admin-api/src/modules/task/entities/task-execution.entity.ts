import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  VersionColumn,
} from "typeorm";
import { Task } from "./task.entity";

export enum ExecutionStatus {
  PENDING = "pending",
  RUNNING = "running",
  /**
   * MUTEX-01（迁移 1790000000044）：互斥排队态。任务挂了互斥组、且候选设备
   * 上的组占用已满时，执行进入 waiting 等待唤醒重派（15s leader cron）。
   * 语义要点：
   * - **不是终态**也不进 stale sweep 的任何回收桶（PENDING/RUNNING 两桶都按
   *   status 精确过滤）——排队多久都不会被误杀；等待无超时，人工 kill/取消
   *   经 A1 终态门照常可用（WAITING 在 OPEN_EXECUTION_STATUSES 内）。
   * - 不消耗 BullMQ 重试预算：processor 命中互斥阻塞时把执行置 waiting 并
   *   正常结束 job（不 rethrow），唤醒后作为全新 job 重新入队。
   * - task.timeout 从真正开跑（startTime）起算，排队时间不计。
   */
  WAITING = "waiting",
  SUCCESS = "success",
  FAILED = "failed",
  TIMEOUT = "timeout",
  KILLED = "killed",
  CANCELLED = "cancelled",
}

export enum ExecutionFailureReason {
  PACKAGE_FETCH_FAILED = "package_fetch_failed",
  SCRIPT_ERROR = "script_error",
  TIMEOUT = "timeout",
  EXECUTOR_OFFLINE = "executor_offline",
  EXECUTOR_RESTART = "executor_restart",
  /**
   * P2: stale sweep 赢得 RUNNING→FAILED 条件 UPDATE 时写入的可溯源标记——
   * 区别于执行器回调上报的 UNKNOWN，便于排查"worker 崩溃型故障 + sweep 兑现
   * 重试预算"的链路。命名沿用既有 snake_case 约定（对齐 executor_restart）。
   */
  STALE_RECOVERED = "stale_recovered",
  /** BUG-10 细化：依赖安装失败（npm install / uv pip install / uv venv） */
  DEPENDENCY_INSTALL_FAILED = "dependency_install_failed",
  /** BUG-10 细化：Git clone/fetch/checkout 失败（区别于包拉取） */
  GIT_FETCH_FAILED = "git_fetch_failed",
  /** BUG-10 细化：运行时/可执行文件不可用（spawn ENOENT、uv 缺失） */
  RUNTIME_MISSING = "runtime_missing",
  /**
   * python_task_multiversion（WS1 · CONTRACT §2.5 / D14）：声明的解释器版本
   * **无法获取**——解释器缓存缺失且下载失败/不可达/超时，或缓存损坏不可修复。
   *
   * 语义要点：
   * - **明确失败**（D14）：不无限等待、**不回退宿主解释器**——版本语义是硬
   *   约束，回退会掩盖版本不匹配问题。典型触发：声明 `3.7`（uv 在线下载
   *   必然失败，`No download found for request: cpython-3.7-<platform>`）
   *   而部署方未离线预填缓存卷。
   * - **执行器可上报**（不进 ADMIN_INTERNAL_FAILURE_REASONS）——触发条件
   *   只有执行器侧可见（缓存池 + 下载结果）。
   * - **不进默认重试集**：由执行器显式上报该 token，配合 task.retryableErrors
   *   白名单语义（RETRY-01 不变：白名单含该 token 时尊重用户选择）。
   * - 与 `RUNTIME_MISSING` 的区别：后者是 uv/解释器**本体**缺失（环境装错），
   *   本值特指**声明版本**不可获得（环境正确但拿不到该版本）。
   */
  INTERPRETER_UNAVAILABLE = "interpreter_unavailable",
  /**
   * SEC-NEW (F-1)：沙箱已配置但不可用（bwrap 缺失 / 用户命名空间被禁 / 在
   * Windows 上配了 TASK_SANDBOX=bwrap）。执行器 fail-closed 拒绝在无沙箱下
   * 运行任务，故这是**执行器侧配置问题**，与任务代码本身无关。
   *
   * 与 `RUNTIME_MISSING` 的区别：后者是 uv/git/python 本体缺失；本值特指
   * 沙箱后端不可用，处置动作是装 bubblewrap 或取消 TASK_SANDBOX。
   *
   * EXP-01（本轮体验审查）：python 执行器自 F-1 起就会产出该值
   * （`routers/execute.py:_refine_failure_reason`），但**三端枚举都没有它**
   * ——回调 DTO 的 @IsIn 命中即 400，而 python 侧把 4xx 当不可重试、
   * **整批放弃**（`_send_callback_batch_with_retry`）。于是一台配错沙箱的
   * 执行器会让该机**所有**任务的终态回调永远送不出去，连同批最多 99 个无关
   * 的成功任务一起丢失，用户看到它们永远停在「运行中」。现补齐枚举。
   */
  SANDBOX_UNAVAILABLE = "sandbox_unavailable",
  KILLED = "killed",
  UNKNOWN = "unknown",
  /**
   * P0（UX-AUDIT-2026-09-21 §P0-4）：任务引用的应用已不存在（被删除）。
   *
   * 此前这条路径抛的是 `Cannot resolve packageUrl ... application <uuid> not
   * found`，而失败原因由**正则链**从错误文本推断——该消息不含
   * `package fetch|download package|git clone` 等关键词，于是落到兜底的
   * UNKNOWN，用户只看到「未知原因：去查看执行日志定位根因」。
   *
   * 而原因是 100% 已知的：任务实体持 applicationId 弱引用，应用被删后
   * `onDelete: "SET NULL"` 只清空该列（任务不会消失），于是任务照旧按 cron
   * 调度、每次都失败。admin 内部专用（执行器根本不参与这条判定）。
   */
  APPLICATION_MISSING = "application_missing",
  /**
   * P0（UX-AUDIT-2026-09-21 §P0-8）：执行从未被派发出去（队列侧超时丢弃）。
   *
   * 与 STALE_RECOVERED 的差别是**语义更精确**：stale sweep 的 PENDING 桶只回收
   * 「从未被派发」的行（见 scheduler.service.ts 的注释），却沿用了泛化的
   * UNKNOWN，而同一次 sweep 的 RUNNING 桶已经升级为 STALE_RECOVERED——同一类
   * 失败按被哪个桶捡到而有不同分类，是内部不一致。
   *
   * 用户侧价值：这类执行**从未在任何机器上运行过**，提示"去看执行日志"是把
   * 排查方向指向一个不存在的东西；正确指向是"执行器为何没取件 / 是否离线"。
   */
  NEVER_DISPATCHED = "never_dispatched",
}

/**
 * A3（DEEP_REVIEW §七 · executor-protocol）：**执行器可上报**的 failureReason
 * 子集 = 全集 − admin 内部专用。
 *
 * `stale_recovered` 是 admin 的 stale sweep 在赢得 RUNNING→FAILED 条件 UPDATE
 * 时写入的可溯源标记，**语义上只有 admin 才该写**（执行器无从得知自己的执行是
 * 被谁终态化的）。此前回调 DTO 用 `@IsIn(Object.values(ExecutionFailureReason))`
 * ——用的是全集，等于允许执行器上报一个它不该产生的取值。
 *
 * 取值清单由 `packages/executor-protocol/protocol.json` 单一事实源钉死（三端
 * 各自断言与本常量一致），此处只做类型安全的派生。
 */
export const ADMIN_INTERNAL_FAILURE_REASONS: readonly ExecutionFailureReason[] =
  [
    ExecutionFailureReason.STALE_RECOVERED,
    // P0-4 / P0-8（UX 审计）：两者都只在 admin 内部产生——执行器既不参与
    // "引用的应用是否还存在"的判定，也无从得知"自己的派发是否已被队列丢弃"。
    ExecutionFailureReason.APPLICATION_MISSING,
    ExecutionFailureReason.NEVER_DISPATCHED,
  ];

export const EXECUTOR_REPORTABLE_FAILURE_REASONS: readonly ExecutionFailureReason[] =
  Object.values(ExecutionFailureReason).filter(
    (reason) => !ADMIN_INTERNAL_FAILURE_REASONS.includes(reason),
  );

/**
 * FEAT-05：单个执行产物（artifact）的清单条目。执行器在任务工作目录下约定
 * `artifacts/` 收集文件，任务结束回调随清单（name/size/sha256）上报，文件字节
 * 单独 PUT 上传到 admin 的 uploads/artifacts/<execId>/ 目录。清单是 best-effort
 * ——收集/上传失败绝不阻塞任务终态。
 */
export interface ExecutionArtifact {
  name: string;
  size: number;
  sha256: string;
}

/**
 * RT-BUDGET-01（迁移 1790000000090）：**重试成因类别**——双预算的分桶键。
 *
 * - `user`：用户侧事实导致的失败/重排（任务代码/配置，含任务自身 timeout 策略
 *   触发的 `timeout_retry`）；
 * - `internal`：引擎内部抖动/恢复（网络抖动、执行器重启、僵尸行回收）。
 *
 * 为什么只有这两个值（不是随便加桶）：`task.maxRetry` 此前是**一个**预算，
 * 「用户失败」与「引擎抖动」共用它 ⇒ 一次执行器重启就烧掉用户一格重试额度。
 * Hatchet 把 `app_retry_count` 与 `internal_retry_count` 分成两个独立计数器
 * （`sql/schema/v1-core.sql:538-540`），本类型是同一分离在 TS 侧的落点。
 *
 * 刻意用 `as const` 元组而不是 `enum`：本仓 `check-enum-drift` 要求每个 enum
 * 要么映射到 PG enum、要么带理由豁免；本值域是 varchar 列上的**业务标签**，
 * 不是 PG 类型（该守卫明确不把 const 元组纳入扫描面）。
 */
export const EXECUTION_RETRY_KINDS = ["user", "internal"] as const;
export type ExecutionRetryKind = (typeof EXECUTION_RETRY_KINDS)[number];

@Entity("task_executions")
@Index(["taskId"])
// NETOPT-3①: 下面两条必须与迁移 DDL 一一对应（名称/列序对齐
// migrations/1790000000029-AddTaskExecutionDeclaredIndexes.ts）。生产
// synchronize=false，迁移是 schema 唯一来源——实体 @Index 只在显式命名且与
// 迁移对齐时才有意义；未命名声明会被 TypeORM 生成哈希名、永不落库，纯属误导
// （原 @Index(["status"]) 独立单列声明即因此从未存在，PENDING 兜底清扫被迫
// O(全表) 游走）。复合索引左前缀已覆盖原单列消费面，故不再声明 ["status"]。
@Index("idx_task_executions_task_id_status", ["taskId", "status"])
@Index("idx_task_executions_status_created_at", ["status", "createdAt"])
@Index(["createdAt"])
@Index("idx_task_executions_executor_address_status", [
  "executorAddress",
  "status",
])
@Index("idx_task_executions_running", ["executorAddress", "startTime"], {
  where: "\"status\" = 'running'",
})
// ADR-017 阶段 3（迁移 1790000000055）：重启恢复查询形态 `executorId = $1
// AND status='running' ORDER BY startTime` 的部分索引。与上面按 address 的
// 那条同款——地址在 pull 同址多行并存时不再唯一，恢复必须按行身份走。
@Index("idx_task_executions_executor_id_running", ["executorId", "startTime"], {
  where: "\"status\" = 'running'",
})
// O-2: the stale sweep filters only on status='running' AND startTime < cutoff
// (no executorAddress predicate), so the (executorAddress, startTime) index
// above cannot be used. A leading-column (startTime) partial index serves it.
@Index("idx_task_executions_start_time_running", ["startTime"], {
  where: "\"status\" = 'running'",
})
// MUTEX-01（迁移 1790000000044）：组占用判定的部分索引——dispatch 占坑事务内
// 的 `WHERE executorAddress=:addr AND mutexGroupId=:g AND status='running'`
// 计数查询走它；只覆盖真正参与互斥的行（组为空的执行不进索引）。
@Index(
  "idx_task_executions_group_occupancy",
  ["executorAddress", "mutexGroupId"],
  { where: '"status" = \'running\' AND "mutexGroupId" IS NOT NULL' },
)
// A4（迁移 1790000000049）：执行历史确定性排序 (taskId, createdAt DESC, id
// DESC)——createdAt 打平（批量触发/扇出常态）时以 id 作稳定 tiebreaker。
// 注意：TypeORM IndexOptions 不支持列序声明，DESC/DESC 只落在迁移 DDL 里
// （同 1790000000022 先例：实体声明记录列集，方向以迁移为准）。
@Index("idx_task_executions_task_id_created_at_id", [
  "taskId",
  "createdAt",
  "id",
])
export class TaskExecution {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() taskId: string;
  @Column() taskName: string;
  @Column({
    type: "enum",
    enum: ExecutionStatus,
    default: ExecutionStatus.PENDING,
  })
  status: ExecutionStatus;

  /**
   * G2-风险 1（S7 §G2「风险 1」· 迁移 1790000000091）：本行是**为可见性而合成**的，
   * **不是一次真实尝试**。
   *
   * 什么是 synthetic：G2 为「未声明失败边」的下游在上游失败时落一条 `cancelled`
   * 行，只为让 `list_executions` 显示「它因为上游失败而没跑」。行里的
   * startTime / params / result / executorAddress / exitCode 全为 null——没有任何
   * 进程跑过它。它不是一次尝试，而是一句结论。
   *
   * 为什么它不参与依赖判定：`areDependenciesSatisfied` 看的是「依赖任务**最新**的
   * 执行行」。若合成行成为最新行，孙节点读到的就是 `cancelled` 而不是它上次的
   * `SUCCESS`，在孙节点未声明失败边（默认 `acceptFailure=false`）时 `cancelled`
   * 不算满足 ⇒ **孙节点静默不触发**——「为让没跑可见」反而让「本来会跑」的不跑，
   * 净负收益（与 Hatchet 的 cancelled 级联同一副作用）。故依赖闸门的「最新执行」
   * 查询一律带 `synthetic = false`，合成行对它如同不存在；`TaskService.triggerDependentTasks`
   * 里「别名哨兵取每个依赖的最新执行」同口径（同一「最新执行」语义，不另立一套）。
   *
   * 为什么列表里仍显示：合成行的**全部价值**就是可见性——`getExecutions` /
   * `getAllExecutions` 的列投影按「实体列全集 − 重型文本列」派生（见
   * execution-list-projection.ts），本列自动入选，列表查询**刻意不过滤** synthetic 行。
   *
   * DEFAULT false 且 NOT NULL：语义上只有两种事实（真实尝试 / 合成行），没有「不知
   * 道」；迁移前不存在合成建行路径，故存量行全部 = false（真实尝试）天然正确——
   * metadata-only，无需回填。真实尝试的判定因此与引入本列前**逐字节相同**。
   */
  @Column({ type: "boolean", default: false }) synthetic: boolean;

  // PK-10（DEEP_REVIEW 0ef3bbe）: FK 语义对齐 DB 迁移。迁移 1717473142679 实际为
  // `ON DELETE CASCADE`（taskId 列 NOT NULL，删任务级联删执行行），此前实体误声明
  // onDelete: "SET NULL"——一次 migration:generate 就会把 CASCADE 翻成 SET NULL
  // （列 NOT NULL，删任务即外键报错）。以迁移为准修正实体为 CASCADE。
  @ManyToOne("Task", "taskExecutions", { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "taskId" })
  task: Task | null;
  @Column({ nullable: true }) executorAddress: string;
  /**
   * ADR-017 阶段 3：派发到的那台执行器的 `executors.id`（行身份）。
   *
   * 为什么必须与 `executorAddress` 并存：阶段 3 把 `uq_executors_address` 收窄为
   * partial（仅 push 行），pull 模式**允许同地址多行并存**（ADR-017 §5）——此时
   * `executorAddress` 不再唯一指代一行，任何「按地址匹配执行行」的面都会命中
   * 别人的行：重启恢复会误杀、互斥占用会算错、产物归属会串台。
   *
   * 可空是刻意的：存量行（本次迁移前派发的）没有该值，那些面回落到地址匹配，
   * 行为与引入前逐字节一致；新派发一律写入。读面（决策 §7 读面富化）也靠它
   * 无歧义地展示「部署到哪台机器」。
   *
   * 不加 FK：执行器行可被删除（cleanupOfflineExecutors），而执行历史必须保留
   * （删行会让历史断裂——正是本 ADR 要消灭的故障）。故以裸 uuid 存快照语义。
   */
  @Column({ type: "uuid", nullable: true }) executorId: string | null;
  @Column({ type: "text", nullable: true }) logs: string;
  /** Where the detailed log lives: 'db' (execution_log_lines) or 's3' object. */
  @Column({ type: "varchar", nullable: true, default: "db" })
  logStorage: string | null;
  /** Gzipped object key when logStorage === 's3'. */
  @Column({ type: "varchar", nullable: true }) logObjectKey: string | null;
  @Column({ type: "jsonb", nullable: true }) result: Record<string, any>;
  @Column({ type: "jsonb", nullable: true }) params: Record<string, any>;
  @Column({ nullable: true }) startTime: Date;
  @Column({ nullable: true }) endTime: Date;
  @Column({ nullable: true }) duration: number;
  @Column({ type: "int", default: 0 }) retryCount: number;
  /**
   * RT-BUDGET-01：**本行为什么被重试**（`user` / `internal`）。
   *
   * NULL 的三种合法来源，都是「不假装知道」而不是漏写：
   * - 非重试行（首次触发/扇出/人工重跑直接建行）：它们不是"某次重试"；
   * - 迁移前的存量重试行：当时没有这一列，历史无法还原；
   * - 由不经过 ExecutorService.scheduleRetryAfterRecovery 的路径建的行。
   *
   * 读侧的 NULL 语义**保守**：NULL 行在两类预算上都被看作「已经用掉了
   * `retryCount` 格」（见 ExecutorService.retryBudgetExhausted 的注释）——
   * 方向是"宁可少给一次重试，也不凭猜测多给一次"（多给 = 静默多跑一次副作用）。
   */
  @Column({ type: "varchar", length: 16, nullable: true })
  retryKind: ExecutionRetryKind | null;
  /**
   * RT-BUDGET-01：本行之前**已由用户类失败消耗掉**的重试次数（累计链式计数）。
   *
   * 为什么用「用户已用」这一列表达拆分（而不是再加第三个计数器）：每条重试恰属
   * 一类，故 internal 已用 = `retryCount`（总数，语义不变）− `retryUserCount`
   * （≥0 截断），两个预算都能从行内数据精确还原，且不改变 `retryCount` 的既有
   * 口径（attempts 扣减、退避指数、读面展示都与改动前逐字节相同）。
   *
   * NULL = 存量行/未记录（迁移不做回填）：读侧按「全部已用」保守处理，与迁移前
   * 的单预算判定逐字节等价。
   */
  @Column({ type: "int", nullable: true })
  retryUserCount: number | null;
  @Column({ nullable: true }) errorMessage: string;
  @Column({ type: "varchar", nullable: true })
  failureReason: ExecutionFailureReason | null;
  /**
   * 改动2（可观测性补齐）：执行器回调上报的原始进程退出码（nullable=未上报）。
   * failureReason 是由 errorMessage/logs/exitCode 推断的分类，本列保留原始
   * 退出码用于失败溯源；幂等迁移见 migrations/1788800000000-AddExecutionExitCode.ts。
   */
  @Column({ type: "int", nullable: true }) exitCode: number | null;
  @Column({ type: "text", nullable: true }) aiAnalysis: string;
  /**
   * FEAT-05: 执行产物清单（见 ExecutionArtifact）。nullable=无产物/未上报。
   * 幂等迁移见 migrations/1789600000000-AddExecutionArtifacts.ts。
   */
  @Column({ type: "jsonb", nullable: true })
  artifacts: ExecutionArtifact[] | null;
  @Column({ nullable: true }) triggerType: string;
  @Column({ nullable: true }) taskVersion: string;
  /**
   * OBS-01: W3C trace-id（traceparent 头的 trace-id 段，32 hex）。
   * 触发/入队侧生成（OTEL_ENABLED=true 时），dispatch traceparent 头透传
   * 执行器，终态行携带供 UI 展示与 Jaeger/Tempo 检索。NULL=追踪未开启或旧数据。
   * 迁移见 migrations/1789900000003-AddExecutionTraceId.ts。
   */
  @Column({ type: "varchar", nullable: true }) traceId: string | null;
  /**
   * FEAT-22 方案 A v1 配套观测：派发时刻解析的应用包与版本（仅 zip 渠道，
   * git/glue 渠道恒 NULL）。任务执行永远跑应用「当前上传版本」——dispatch
   * 那一刻解析 applications.packageUrl（30s 正缓存）附加到下发载荷，执行器
   * 每次现下载。执行行此前不记录"本次到底用的哪个包/哪个版本"，应用连续
   * 上传多版后历史执行的版本不可回溯（「这台设备上次跑的是 v1 还是 v2」
   * 只能靠猜）。NULL=非 zip 渠道 / 解析失败（失败另有 failureReason）。
   * 迁移见 migrations/1790000000046-AddExecutionResolvedPackage.ts。
   */
  @Column({ type: "varchar", nullable: true }) resolvedPackageUrl:
    string | null;
  @Column({ type: "varchar", nullable: true }) resolvedPackageVersion:
    string | null;
  @CreateDateColumn() createdAt: Date;

  /**
   * NETOPT-3②（迁移 1790000000030）：依赖扇出完成标记（旁路标记，非终态、
   * 不参与 A1 状态机）。NULL = SUCCESS 终态已落定但扇出未确认完成——重复
   * 回调必须重放 triggerDependentTasks；非 NULL = 扇出全部成功，重放不再
   * 进行。仅 TaskService 在扇出全部成功后条件写入（depsFiredAt IS NULL →
   * now），失败/部分失败刻意不落，留 NULL 供重放与观测。
   */
  @Column({ type: "timestamptz", nullable: true })
  depsFiredAt: Date | null;

  /**
   * MUTEX-01（迁移 1790000000044）：创建执行时从 task→application 带下的
   * **互斥组快照**（无 FK）。调度侧互斥判定只读本列：
   * - 非空 → dispatch 占坑时检查「同设备同组占用 < 组内并发数」，满了置
   *   waiting 排队；
   * - NULL → 不参与互斥，派发行为与引入前逐字节一致。
   * 为什么是快照而不是运行时 join：占用判定是热路径单表查询；且组被删
   * （应用 FK SET NULL）后在途执行仍按创建时的组语义走完，历史不失真。
   */
  @Column({ type: "uuid", nullable: true }) mutexGroupId: string | null;

  /**
   * R-P0-007: Optimistic lock version for preventing concurrent updates
   *
   * S3-C5 的收尾协调记录（attempt/leaseOwner/leaseExpiresAt/controllerBootId/
   * recoveryHistory）**刻意不放在本实体上**，而是独立表 `execution_finalizations`
   * （实体见 `execution-finalization.entity.ts`）。原因有两条，都能机械复核：
   * ① 本仓有「实体列 ⊆ 执行读 DTO 声明」的机械不变量
   *    （`__tests__/execution-executor-id.dto.spec.ts`）。加列会把内部收尾细节
   *    （leaseOwner/controllerBootId/recoveryHistory）发布进公开执行响应契约，
   *    并迫使重生成 openapi.json 与 admin-web 的生成物；
   * ② 该表的写者只有 stale sweep 一个，竞争面与终态写路径不重叠。
   */
  @VersionColumn() version: number;
}
