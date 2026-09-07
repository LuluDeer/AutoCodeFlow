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

  @ManyToOne("Application", "tasks", { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "applicationId" })
  application: { id: string; name: string; version: string } | null;

  /** Executor group to use for this task. */
  @Column({ nullable: true }) executorGroup: string | null;

  /** Executor tags required for this task. */
  @Column({ type: "simple-array", nullable: true }) executorTags:
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
