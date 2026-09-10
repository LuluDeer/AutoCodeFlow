import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { TaskMaintenanceWindows } from "../maintenance-window.util";

export enum TaskStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  DELETED = "deleted",
}
export enum BlockStrategy {
  SERIAL = "serial",
  DISCARD = "discard",
  COVER_EARLY = "cover_early",
}

export enum TaskPriority {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}

/**
 * N2: `tasks.priority` 在 DB 中是 PG 字符串枚举 `task_priority_enum`（labels:
 * low/normal/high/critical），而 TS `TaskPriority` 是数字枚举（1-4）。TypeORM
 * 从 PG enum 列读回的运行时值是字符串 label（如 'normal'——仅当 label 恰好
 * 能 parseInt 成枚举中的数字时才会转成数字，见 PostgresDriver
 * prepareHydratedValue）。BullMQ 的 priority 选项要求整数，字符串会被 lua
 * 校验拒绝（"Priority should not be float"），导致所有调度触发入队 100% 失败。
 *
 * 本函数在入队边界把任意运行时形态健壮地归一化为 TaskPriority 数字：
 * - 合法数字（1-4）原样返回；整数字符串（'1'..'4'）转数字后返回
 * - label 大小写不敏感（'normal' / 'NORMAL' / 'High'）映射到对应数字
 * - 未知 / 缺失 / 非法值一律回退 NORMAL(2)——绝不把字符串传给 BullMQ
 */
export function normalizeTaskPriority(value: unknown): TaskPriority {
  const validNumbers = Object.values(TaskPriority).filter(
    (v): v is number => typeof v === "number",
  );
  if (typeof value === "number" && validNumbers.includes(value)) {
    return value as TaskPriority;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      const numeric = Number(trimmed);
      if (Number.isInteger(numeric) && validNumbers.includes(numeric)) {
        return numeric as TaskPriority;
      }
      // TS 数字枚举运行时会带 '1'..'4' 反向映射键，过滤后仅保留 label 键
      const label = (Object.keys(TaskPriority) as string[])
        .filter((k) => Number.isNaN(Number(k)))
        .find((k) => k.toLowerCase() === trimmed.toLowerCase());
      if (label) {
        return TaskPriority[label as keyof typeof TaskPriority];
      }
    }
  }
  return TaskPriority.NORMAL;
}
export enum ExecuteMode {
  SINGLE = "single",
  BROADCAST = "broadcast",
}
export enum MisfireStrategy {
  IGNORE = "ignore",
  FIRE_ONCE = "fire_once",
}
export enum TaskTriggerType {
  CRON = "cron",
  FIXED_RATE = "fixed_rate",
  API = "api",
  MANUAL = "manual",
}
export enum TaskRuntime {
  PYTHON = "python",
  NODE = "node",
  SHELL = "shell",
}

@Entity("tasks")
@Index(["status"])
@Index(["applicationId"])
@Index(["createdAt"])
export class Task {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() name: string;
  @Column({ nullable: true }) description: string;
  @Column({ type: "enum", enum: TaskStatus, default: TaskStatus.ACTIVE })
  status: TaskStatus;
  @Column({ type: "enum", enum: TaskTriggerType }) triggerType: TaskTriggerType;
  @Column({ nullable: true }) cronExpression: string;
  @Column({ nullable: true }) timezone: string;
  @Column({ nullable: true }) fixedRate: number;
  @Column({ type: "enum", enum: TaskRuntime, default: TaskRuntime.PYTHON })
  runtime: TaskRuntime;
  @Column({ nullable: true }) runtimeVersion: string;
  @Column({ type: "jsonb", nullable: true }) dependencies: Record<
    string,
    string
  >;
  @Column({ nullable: true }) entrypoint: string;
  /**
   * W-21 (windows-findings): dependency specs the executor installs before
   * running the task — python runtime → `uv pip install` into a per-task venv
   * (executor-python); node runtime → npm packages (executor-node). Consumed
   * only by entrypoint (packaged) tasks; glue-script tasks clear it to [] in
   * both executors (glue uses the system interpreter, no per-task deps).
   * Carried verbatim on the dispatch payload (`{executionId, task, params}`),
   * so no dispatch change is needed — the entity field reaches the executor.
   */
  @Column({ type: "jsonb", nullable: true }) requirements: string[] | null;
  @Column({ nullable: true }) gitRepo: string;
  @Column({ nullable: true }) gitBranch: string;
  @Column({ nullable: true }) gitCommit: string;
  @Column({ nullable: true }) currentVersion: string;
  @Column({ type: "int", default: 0 }) timeout: number;
  @Column({ type: "int", default: 3 }) maxRetry: number;
  @Column({ type: "int", default: 0 }) retryDelay: number;
  /**
   * RETRY-01: whitelist of retryable failures, consumed by TaskProcessor's
   * dispatch-failure handler. When non-empty, a failed execution is retried by
   * BullMQ ONLY if one of these entries is a case-insensitive substring of the
   * execution's errorMessage (primary) or its classified failureReason token
   * (secondary); otherwise the failure is reclassified as UnrecoverableError
   * and fails fast. null/empty array → retry every failure (legacy default).
   * TIMEOUT is always non-retryable regardless of this list (double-dispatch
   * guard in the processor).
   */
  @Column({ type: "simple-array", nullable: true }) retryableErrors: string[];
  @Column({ type: "enum", enum: BlockStrategy, default: BlockStrategy.SERIAL })
  blockStrategy: BlockStrategy;
  @Column({
    type: "enum",
    enum: MisfireStrategy,
    default: MisfireStrategy.IGNORE,
  })
  misfireStrategy: MisfireStrategy;
  /**
   * CORE-01 回归修复：CORE-01 前端以数字（1-4）提交 priority，而本列的 PG
   * enum 只接受 label 字符串（'normal' 等，见 N2 注释）——数字直写 PG 报
   * `invalid input value for enum` 500（create/PATCH 全线炸，e2e 23-25/29 红）。
   * 入队边界的 normalizeTaskPriority 只救 BullMQ，救不了实体落库。transformer
   * 在列级把数字统一转小写 label，覆盖一切写路径（save/upsert/query builder
   * 之外的 set+save 均经此）；读路径恒为 label 字符串，from 保持透传。
   */
  @Column({
    type: "enum",
    enum: TaskPriority,
    default: TaskPriority.NORMAL,
    transformer: {
      to: (v?: unknown): string | undefined => {
        if (typeof v === "number") {
          return String(TaskPriority[v]).toLowerCase();
        }
        return v as string | undefined;
      },
      from: (v?: unknown): unknown => v,
    },
  })
  priority: TaskPriority;
  @Column({ type: "enum", enum: ExecuteMode, default: ExecuteMode.SINGLE })
  executeMode: ExecuteMode;
  @Column({ nullable: true }) lastTriggerTime: Date;
  @Column({ nullable: true }) alarmEmail: string;
  @Column({ type: "simple-array", nullable: true }) alarmChannels: string[];
  @Column({ type: "jsonb", nullable: true }) params: Record<string, any>;
  @Column({ nullable: true }) executorAppName: string;
  @Column({ nullable: true }) applicationId: string;

  /**
   * AUTH-01（多租户 Project，第一批）：任务归属项目（可空）。迁移
   * 1790000000008 加列 + FK ON DELETE SET NULL + 索引，并把存量行回填到
   * 默认项目（DEFAULT_PROJECT_ID，project.entity.ts）。NULL = 显式未分配，
   * 列表过滤面按「IS NULL OR = 默认项目」归入默认项目视图（见
   * task.service.findAll）。@ManyToOne 用字符串引用（与上方 Application
   * 关系同款）避免与 project 模块循环导入。
   */
  @Column({ type: "uuid", nullable: true })
  projectId: string | null;

  @ManyToOne("Project", "tasks", { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "projectId" })
  project: { id: string; name: string } | null;

  /**
   * NF-03（任务级 RBAC 预研）：创建者用户 id。NULL=无主（存量行不回填，
   * 仅 ADMIN 可改）；非 NULL 时非 admin 用户只能改自己的（写面守卫在
   * task.service.assertCanWrite）。不加 FK——用户删除后保留悬垂 id，
   * 守卫按「≠当前用户」比较，悬垂语义=非本人 → 403，方向安全。
   */
  @Column({ type: "integer", nullable: true })
  ownerUserId: number | null;

  /**
   * SEC-02: 任务级 secrets（凭据形态的键值对，独立于 params 的普通运行参数）。
   * 存储格式由 SEC_SECRETS_KEY 决定：配置 key 后所有叶子值为
   * `enc:v1:<iv>:<tag>:<ciphertext>`（AES-256-GCM，见 common/utils/
   * secret-crypto.util.ts）；未配置时降级明文存储（零破坏升级路径）。
   * 写路径：TaskService.create/update 经 SecretsCryptoService.encryptForStorage；
   * 读路径：API 响应经 maskForResponse 脱敏（叶子值永不回传）；
   * 派发路径：ExecutorService.dispatch/dispatchBroadcast 经 decryptForDispatch
   * 解密后与 params 合并注入执行器 env（AUTOFLOW_<KEY>），不落 TaskExecution.params
   * （明文不二次入库）。存量行不做迁移加密——首次 update 时自然转为密文。
   */
  @Column({ type: "jsonb", nullable: true })
  secrets: Record<string, unknown> | null;

  @ManyToOne("Application", "tasks", { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "applicationId" })
  application: { id: string; name: string; version: string } | null;

  /** Executor group to use for this task. */
  @Column({ nullable: true }) executorGroup: string | null;

  /** Executor tags required for this task. */
  @Column({ type: "simple-array", nullable: true }) executorTags:
    string[] | null;

  /**
   * NF-04: 标签亲和（可空 simple-array，null/[] = 无约束）。OR 语义——
   * 执行器持有**任一**亲和标签即命中候选。与 executorTags（硬性能力要求，
   * AND 子集语义）互补：亲和是「软路由意向」（派给 gpu 池*或*edge 池皆可），
   * 由 loadScore 在命中集合内继续择优。过滤先于 loadScore 排序；候选为空
   * 走既有「No online executors match the requested group/tags/runtime」
   * 失败路径（processor 分类为 EXECUTOR_OFFLINE）。broadcast 模式下亲和
   * 把广播收窄为「命中亲和标签的执行器子集」——这是第三态相对 pinning
   * （唯一）与 broadcast（全体）的价值所在。默认 null 行为零变化。
   */
  @Column({ type: "simple-array", nullable: true }) executorAffinityTags:
    string[] | null;

  /**
   * NF-04: 标签反亲和（可空 simple-array，null/[] = 无约束）。排除语义——
   * 执行器持有**任一**反亲和标签即被排除。单发与 broadcast 均生效；
   * 与亲和组合时先取亲和命中集再剔除反亲和命中（交集语义）。默认 null
   * 行为零变化。
   */
  @Column({ type: "simple-array", nullable: true }) executorAntiAffinityTags:
    string[] | null;

  /**
   * Pinned executor: when set, dispatch targets ONLY this executor,
   * bypassing group/tags/runtime filtering. If it is offline or missing the
   * execution fails immediately (no fallback to the fleet). Plain column
   * without FK relation on purpose — executor rows are hard-deletable
   * (DELETE /executors/:id) and a pin must not block or cascade that.
   * Mutually exclusive with executeMode=broadcast (enforced in TaskService).
   */
  @Column({ nullable: true }) executorId: string | null;

  /** Glue script: source code editable in the admin UI (XXL-JOB GLUE mode). */
  @Column({ type: "text", nullable: true }) glueSource: string | null;

  /** Language of the glue script: python, javascript, shell. */
  @Column({ nullable: true }) glueLanguage: string | null;

  /**
   * FEAT-06: 任务级维护窗口（可空 jsonb 数组）。
   * 形态 [{ start: "30 2 * * *", end: "0 4 * * *", description?: string }]，
   * start/end 均为 5 字段 cron：start 最近触达开窗、end 最近触达关窗
   * （半开区间 [start, end)，语义详见 task/maintenance-window.util.ts）。
   * 计划触发（scheduler.enqueue）命中窗口即跳过；手动/API 触发不受限。
   * 结构校验在 CreateTaskDto 边界完成。
   */
  @Column({ type: "jsonb", nullable: true })
  maintenanceWindows: TaskMaintenanceWindows | null;

  /**
   * FEAT-11: 任务运行手册（可空 text，markdown）。失败时的排障知识：
   * 任务详情页展示，并作为 OBS-02 告警路由的 runbook 链接/内容来源。
   * 列可空——未配置 runbook 的任务行为零变化（迁移 1789400000000）。
   */
  @Column({ type: "text", nullable: true })
  runbook: string | null;

  /**
   * CORE-04: 超时后动作（可空 varchar，值域见 timeout-policy.util.ts 的
   * TimeoutAction）。null/缺省 = kill——与既有单级树杀语义完全一致：
   * 执行器到时杀进程树并回调 timeout 终态，admin 不额外动作。
   *  - kill_retry：同样树杀，但 admin 侧在超时终态落定后按既有重试预算
   *    （maxRetry/retryDelay，复用 ExecutorService 的 re-enqueue 模式）
   *    兑现一次重试；预算耗尽退化为普通 kill。
   *  - notify_only：admin 不额外下发终止指令（执行器自身的硬超时仍在，
   *    进程树仍会被执行器杀掉并回调——本策略只改变 admin 侧行为），保证
   *    超时告警发出。notify_only ≠ 不超时，文档写明边界。
   * 决策逻辑统一在 task/timeout-policy.util.ts，processor/TaskService
   * 共享同一实现。
   */
  @Column({ type: "varchar", nullable: true })
  timeoutAction: string | null;

  /**
   * CORE-04: 超时预警阈值（占 timeout 的百分数，整数 0-90，可空）。
   * 执行运行时长达到 timeout×ratio/100 时发送一次 WARNING 预警通知
   * （NotificationService.notifyTimeout），每个执行至多一次。null =
   * 未启用预警——存量任务零新通知。无 DB 约束，值域由 DTO 边界与
   * normalizeTimeoutWarnRatio 双重把关。
   */
  @Column({ type: "int", nullable: true })
  timeoutWarnRatio: number | null;

  /**
   * CORE-05: 预估执行时长（秒，可空整数，0/缺省 = 未知）。任务侧属性，
   * 仅参与调度侧的执行器负载评分（ExecutorService 的 loadScore 加权），
   * 心跳与统计面不消费该字段。null/0 表示未知——未知时长任务在评分中
   * 按 ANTI_AFFINITY 公式的默认项计（见 executor.service.ts 的
   * ESTIMATED_DURATION_WEIGHTS），行为与既有短任务语义对齐。
   */
  @Column({ type: "int", nullable: true })
  estimatedDurationSec: number | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;

  /**
   * DB-001: TypeORM 软删除列。与 status='deleted' 逻辑删除并存：
   * - Repository find/findOne 自动排除已设置 deletedAt 的行（框架层过滤）；
   * - status='deleted' 继续保留作为业务语义标记（现有查询依赖 Not(DELETED)）。
   * - 原生 SQL / QueryBuilder（无 withDeleted 处理）不会自动排除，需自行过滤。
   */
  @DeleteDateColumn({ nullable: true })
  @Index("idx_tasks_deleted_at")
  deletedAt: Date | null;
}
