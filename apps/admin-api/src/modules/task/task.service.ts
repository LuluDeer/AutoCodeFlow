import {
  Injectable,
  Logger,
  ConflictException,
  ForbiddenException,
  Inject,
  Optional,
  forwardRef,
  OnModuleInit,
} from "@nestjs/common";
// LANG-ERR-01: 用户可见失败一律抛 AppError（稳定码 + 结构化参数），文案由前端
// 按用户语言翻译；`zh` 仅作不翻译消费者（CLI/MCP/日志/落库）的兜底。
import { AppError } from "../../common/errors/app-error";
// R32-B1：执行类写面的「判定不可用」必须抛出稳定码（503），故按规范用取值形态。
import { ErrorCode } from "../../common/errors/error-codes";
import { InjectRepository } from "@nestjs/typeorm";
import {
  assertAndPinExecutorUrl,
  assertSafeGitRepoUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
// A2-B: 属主/项目角色校验的运行时证据落点
import { recordOwnershipAssertion } from "../../common/guards/ownership-assertion.store";
import {
  DataSource,
  And,
  ILike,
  In,
  IsNull,
  Not,
  Or,
  Between,
  QueryFailedError,
  Repository,
  SelectQueryBuilder,
} from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  TaskRuntime,
  TaskCodeSource,
  ExecuteMode,
  BlockStrategy,
  normalizeTaskPriority,
} from "./entities/task.entity";
import { UserRole } from "../users/entities/user.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "./entities/task-execution.entity";
// A1: 终态跃迁（条件 UPDATE + RETURNING + 驱动兜底）的单一入口。
import {
  transitionToTerminal,
  transitionOneToTerminal,
} from "./execution-terminal";
// MUTEX-01：互斥组快照解析（执行创建时从 task→application 带下）。
import { resolveTaskMutexGroupId } from "./execution-mutex";
// N-14：blockStrategy 闸门（与调度路径共享，比较维度=任务+参数）
import {
  applyBlockStrategyGate,
  canonicalizeParams,
  releaseExecutorSlotByAddress,
} from "./block-strategy-gate"; // A4: DB 优先级(4=紧急) → BullMQ 出队优先级(1=最高)的方向换算。
import { toBullPriority } from "../../common/utils/task-priority.util";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { TaskVersion } from "./entities/task-version.entity";
// ARTIFACTS-INDEX-46: 产物元数据索引行（跨模块 forFeature 同款纪律——只
// import 实体类，TypeORM 元数据无运行时依赖环，注册在 task.module.ts）。
import { ExecutionArtifactRow } from "../artifacts/entities/execution-artifact.entity";
// python_task_multiversion（FR-19 / AC-19a）：zip 来源的 runtime 一致性校验
// 需读 applications 行。**刻意经 dataSource.getRepository(Application)** 而非
// @InjectRepository：ApplicationModule imports forwardRef(() => TaskModule)，
// 在 TaskModule 里 import ApplicationModule 会构成模块环；dataSource 已注入
// （见构造器），且先例同 scheduler.service.ts:726 的 getRepository(Executor)。
// 只 import 实体类（TypeORM 元数据，无运行时依赖环）——与 task.module.ts 的
// ExecutionReport / Project 跨模块 forFeature 同款纪律。
import { Application } from "../application/entities/application.entity";
import { CreateTaskDto } from "./dto/create-task.dto";
import { UpdateTaskDto } from "./dto/update-task.dto";
import { TriggerTaskDto } from "./dto/trigger-task.dto";
// FEAT-RENAME：名称的服务层守卫（编程式调用方绕过全局 ValidationPipe，见 create()）。
import { describeTaskNameProblem } from "./dto/task-name.constraint";
// E-1: 任务定义导入/导出（纯函数层：白名单装配/映射/重名后缀推导）
import {
  buildTaskExportResult,
  importNameCandidate,
  mapExportToCreateDto,
  TASK_IMPORT_MAX_NAME_CONFLICTS,
  type TaskExportResult,
  type TaskImportResult,
} from "./task-definition.util";
import { ImportTaskDto } from "./dto/task-definition-import.dto";
// cron 写边界规范化：裸 n/step（POSIX 语义）等价改写为调度器可注册的规范式
import { normalizeCron5Field } from "./cron-normalize.util";
import { PaginationDto, paginate } from "../../common/dto/pagination.dto";
import {
  ListTasksQueryDto,
  TASK_PROJECTION_WHITELIST,
} from "./dto/list-tasks-query.dto";
// PERF-03：执行列表端点的读投影（排除 logs/aiAnalysis 两个重型 text 列）。
import {
  executionListSelectMap,
  executionListSelectColumnsAliased,
} from "./execution-list-projection";
// CSV 导出的列定义（表头 + 行渲染）与公共安全原语（公式注入防护 / RFC 4180 /
// 有痕截断注释行）。抽到独立模块是为了让"防护"与"业务列"分层：前者是跨端点
// 复用的判据，后者是本域自己的取舍。
import { executionCsvHeaderRow, executionToCsvRow } from "./execution-csv";
import { csvTruncationMarker } from "../../common/utils/csv-export.util";
// rt-3：终态事件载荷只带日志首行摘要（硬切 500，与告警 errorSummary 共用同一
// 常量/函数）；事件广播不传日志全文，全文留在 DB/S3 数据面。
import { logHeadOf } from "../../common/utils/execution-summary.util";
// §2.1 游标分页：keyset 游标的编解码（纯函数，非法输入一律 400 VALIDATION_FAILED）。
// 推广到 GET /tasks 后**只有一份实现**——`*KeysetCursor*` 是通用名，
// `*ExecutionCursor*` 是 executions 端点沿用下来的别名（转调，不是副本）。
import {
  decodeExecutionCursor,
  decodeKeysetCursor,
  nextExecutionCursor,
  nextKeysetCursor,
} from "../../common/utils/keyset-cursor.util";
import {
  isValidRuntimeVersionFormat,
  isRuntimeVersionSupported,
  buildUnsupportedVersionMessage,
} from "./runtime-version.util";
import { SchedulerService } from "../scheduler/scheduler.service";
import { AiService } from "../ai/ai.service";
// ARCH-30: on-demand 分析同走服务化封装（重试 + autoflow_ai_analysis_total
// 指标 + fail-open），processor 直调点与手动分析点共用同一降级/观测策略。
import { AiAnalysisService } from "../ai/ai-analysis.service";
import { ExecutorService } from "../executor/executor.service";
// R-28（DEEP_REVIEW 0ef3bbe）: 依赖触发链路补审计。TaskService 此前不注入
// AuditService（notifyCallbackFailure 审计已迁 listener）；此处仅为「依赖触发
// 无 user 主体、绕过控制器审计」的系统动作补 best-effort 审计。@Optional 与
// eventBus/projectAccess 同先例——存量单测未提供时降级 null，主链不变。
import {
  AuditService,
  // NETOPT-3⑤: API-09 的 LIKE 元字符转义 util 第三处落点（同模块函数导入，
  // 不新增依赖）——getAllExecutions 的 taskName/executorAddress 两个 ILIKE
  // 此前直接 `%${input}%` 裸插值，`_`/`%` 被当通配符，搜索结果静默变宽。
  escapeLikePattern,
} from "../audit/audit.service";
// ARCH-21: 领域事件总线——终态事件（execution.completed/failed）发布入口。
// 主链由此与 NotificationService 彻底解耦（验收红线：本文件不再 import 它）。
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../common/events/domain-events";
// ARCH-21: AuditService import 随注入移除（唯一消费方 notifyCallbackFailure 已迁监听器）。
import { MAX_LOG_BYTES, S3LogStorage } from "./log-storage/s3-log-storage";
// SEC-02: 任务级 secrets 落库加密 / 读脱敏 / 派发解密的统一入口
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
// AUTH-01: 默认项目 uuid（"default" 过滤映射目标，与迁移 1790000000008
// 回填值共享同一常量出处 project.entity.ts）。
import { DEFAULT_PROJECT_ID, Project } from "../project/project.entity";
// AUTH-02: 项目级角色（写面/执行类写面归属判定）
import {
  ProjectAccessService,
  type ProjectRoleResolution,
} from "../project/project-access.service";
// CORE-04: 超时策略归一化（DTO 边界之外的运行态兜底——编程式/旧数据形态）
// FIX-3.1: timeoutWarnThresholdMs 首次接入运行期消费点（超时预警，见
// maybeNotifyTimeoutWarning）。
import {
  normalizeTimeoutAction,
  normalizeTimeoutWarnRatio,
  timeoutWarnThresholdMs,
} from "./timeout-policy.util";
// FIX-4.2: 执行终态唤醒（Redis pub/sub）——webhook 同步等待的事件化通道。
import { ExecutionWakeService } from "./execution-wake.service";
// FIX-3.1: 超时预警的每执行至多一次 SETNX 闸（acquireLock 即 SET NX+TTL）。
import {
  RedisLockService,
  // B-5: 闸门 TOCTOU 锁（Lock 仅为类型引用）
  Lock,
} from "../../common/services/redis-lock.service";

/**
 * B-5（调度域审计）：触发闸门 TOCTOU 锁的 TTL（毫秒）。持锁窗口只需覆盖
 * 「闸门检查 + 执行行落库」——秒级即可；进程崩溃时锁随 TTL 自然过期，不
 * 会像去重锁那样刻意滞留。
 */
export const TRIGGER_GATE_LOCK_TTL_MS = 5_000;
/**
 * FIX-3.1（ARCH-21 红线的**显式例外**）：NotificationService 重新进入本文件。
 * ARCH-21 红线针对的是「终态事件 → 通知」主链解耦——该链路仍走事件总线
 * （emitTerminalEvent → ExecutionEventsListener），未被破坏。本次新增的是
 * 另一条独立旁路：运行中执行的超时预警（用户指令指定直调
 * NotificationService.notifyTimeout；A-11 起签名扩展了可选 alarmChannels
 * 尾参用于与失败告警同源渠道路由，缺省行为不变）。约束自我收紧为：
 * 仅 maybeNotifyTimeoutWarning 一个调用点、fire-and-forget、任何失败吞掉、
 * 不进入任何终态写路径。
 */
import { NotificationService } from "../notification/notification.service";
// OBS-03: 日志行级别推断（纯函数）——写入落库 + S3 读取后过滤共用同一实现
import { levelOfLine } from "./log-level.util";
// CORE-02: 重试退避抖动——±20% 摊开同时刻重试，避免 thundering herd
import { jitteredRetryDelayMs } from "./retry-backoff.util";
// OBS-04: 执行时间线映射（纯函数）——report 端点与 mcp-server timeline 同语义
import { buildExecutionTimeline } from "./execution-timeline.util";
// OBS-04: execution_reports 当日聚合行读侧（写方为 MetricsService.generateReport）
import { ExecutionReport } from "../metrics/entities/execution-report.entity";
// 可观测性补齐轮：运行时计数器埋点入口（模块级纯内存自增，无模块环，
// 见 metrics/runtime-metrics-entry.ts 注释）。
import {
  recordRuntime,
  setRuntimeGauge,
} from "../metrics/runtime-metrics-entry";
// OBS-01: OpenTelemetry 追踪（@Global；OTEL_ENABLED=false 时全方法短路）
import { TracingService } from "../../common/tracing/tracing.service";

/**
 * Detects truncation markers inserted by executors when callback logs exceed
 * the payload limit.
 * Node:   "... [logs truncated, original length N chars] ..."
 * Python: "...[truncated, total N chars]..."
 */
const LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i;

/**
 * TASK-007: 依赖环检测的深度/访问节点上限。数据库中若存在超长依赖链
 * （例如 100 层），无上限的逐层递归会触发串行 N+1 查询，构成 DoS 向量；
 * 超过上限直接抛 BadRequestException("dependency chain too deep")。
 */
export const MAX_DEPENDENCY_DEPTH = 64;

/**
 * F-03（本轮审计）: findAll 的排序字段白名单。
 *
 * 只放行 **Task 实体真实存在的可排序列**（逐一核对 task.entity.ts 列清单）——
 * TypeORM 的 order 键非法会直接抛错，白名单让"请求即 400"且语义清晰，同时
 * 防止未来给 order 键传入任意表达式（order 键注入面收口）。priority 为 PG enum
 * label（'low'/'normal'/'high'/'critical'），按 label 排序是稳定可用的。
 */
const TASK_SORT_WHITELIST = [
  "id",
  "name",
  "status",
  "runtime",
  "runtimeVersion",
  "triggerType",
  "timeout",
  "maxRetry",
  "priority",
  "lastTriggerTime",
  "estimatedDurationSec",
  "createdAt",
  "updatedAt",
] as const;

type TaskSortKey = (typeof TASK_SORT_WHITELIST)[number];

/**
 * R4-P3: 依赖扇出短窗 DB claim 的窗口（毫秒）。只需覆盖"两个上游回调
 * 并发完成、双方 checkDependencies 都判满足"的竞态窗口；10s 足够，
 * 同时把对 tasks.lastTriggerTime 共享语义的影响压到最小（见
 * claimDependencyTrigger 的权衡注释）。
 */
export const DEPENDENCY_TRIGGER_CLAIM_WINDOW_MS = 10_000;

// B-6: 依赖满足判定/扫描上限迁至 dependency-gate.util（scheduler misfire
// 补偿闸共用）；此处保留 re-export 维持既有 import 面（task.service.spec 等）。
import {
  areDependenciesSatisfied,
  MAX_DEPENDENCY_EXECUTION_SCAN,
} from "./dependency-gate.util";
export { MAX_DEPENDENCY_EXECUTION_SCAN };

/**
 * FEAT-21: 依赖触发链的上游结果透传（opt-in）。
 *
 * triggerDependentTasks 此前以 this.trigger(task.id, {}) 触发下游——下游永远
 * 拿不到上游的执行结果，"跑应用 → 依赖任务回写结果"这类链在平台内串不起来。
 * 透传走 **opt-in 哨兵**而非无条件注入：下游任务 params 里值为 `$upstream`
 * （整个上游上下文对象）或 `$upstream.<dot-path>`（取上下文字段，路径落空
 * 归 null）的字符串在触发时被替换。未声明哨兵的下游行为逐字节不变——
 * 不注入即不走 dto.params 覆盖语义，仍用任务默认 params。
 */
// B-9: TASK_PARAMS_MAX_BYTES 迁至 params-size.util（DTO 校验器共用，避免
// DTO → service 模块环）；此处 re-export 维持既有 import 面（task-webhook 等）。
import { TASK_PARAMS_MAX_BYTES } from "./params-size.util";
export { TASK_PARAMS_MAX_BYTES };

/**
 * `GET /tasks/executions/export` 的行上限（安全阀）。
 *
 * 取 5 万而不是对齐审计导出的 1 万：执行记录是**按天增长、按 90 天硬删**的
 * 运维事实表，1 万行在中等规模的实例上连三天都不到，导出会变成"永远被截断"
 * ——一个永远触发截断提示的能力等于没有能力。5 万行 × 平均 300 字节 ≈ 15 MB，
 * 对一个手动触发的 ADMIN 导出是可接受的量级；真需要更多请按 `startTime`/
 * `endTime` 分段导出（那是有意义的切分，OFFSET 式的"第 N 页"不是）。
 */
export const EXECUTION_EXPORT_ROW_CAP = 50_000;

/**
 * 导出时的单次 DB 取数页大小。
 *
 * 与行上限解耦：它是"每次往返拿多少行进内存"的量，不是"导出多少行"。1000
 * 行足以摊薄往返开销，又不会让单页文本大到撑爆背压窗口（约 300 KB/页）。
 */
const EXECUTION_CSV_PAGE_SIZE = 1_000;

export const UPSTREAM_SENTINEL = "$upstream";

export interface UpstreamExecutionContext {
  executionId: string;
  status: string;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  failureReason: string | null;
  startTime: Date | null;
  endTime: Date | null;
  duration: number | null;
  executorAddress: string | null;
  exitCode: number | null;
}

/** 从上游执行行取透传上下文（结构化子集——logs 等大字段不进扇出路径）。 */
export function buildUpstreamContext(exec: {
  id: string;
  status: string;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  failureReason?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  duration?: number | null;
  executorAddress?: string | null;
  exitCode?: number | null;
}): UpstreamExecutionContext {
  return {
    executionId: exec.id,
    status: exec.status,
    result: exec.result ?? null,
    errorMessage: exec.errorMessage ?? null,
    failureReason: exec.failureReason ?? null,
    startTime: exec.startTime ?? null,
    endTime: exec.endTime ?? null,
    duration: exec.duration ?? null,
    executorAddress: exec.executorAddress ?? null,
    exitCode: exec.exitCode ?? null,
  };
}

/** walk 内部标记："该字符串不是哨兵，原样保留"。 */
const SENTINEL_SKIP = Symbol("sentinel-skip");

/**
 * G6 第二步：按**依赖别名**取上游输出——`$upstream("别名")` /
 * `$upstream("别名").result.foo`。
 *
 * 为什么需要：legacy `$upstream` 只透传「本次触发扇出的那一个上游」的上下文，
 * 无法表达「这条边传哪个上游的哪个字段」。别名 = `dependencies` 的键
 * （显示名），因此不需要迁移、不影响 GIN 索引。
 *
 * 解析期不做「别名必须存在」的强校验：dependencies 与 params 可分次 PATCH，
 * 校验会把「先存 params 后存依赖」的正常编辑顺序判 400。运行时未知别名解析为
 * null（显式缺失，脚本侧可判断），而不是保留哨兵字符串（那会被当普通参数）。
 */
const UPSTREAM_ALIAS_SENTINEL_RE =
  /^\$upstream\("([^"\\]{1,64})"\)(?:\.([A-Za-z0-9_.-]+))?$/;

/** 解析 `$upstream("alias")[.path]`；非该形态返回 null。 */
function parseUpstreamAliasSentinel(
  value: string,
): { alias: string; path: string | null } | null {
  const m = UPSTREAM_ALIAS_SENTINEL_RE.exec(value);
  if (!m) return null;
  return { alias: m[1], path: m[2] ?? null };
}

/** params 是否声明了**别名**哨兵（扇出侧据此决定是否批量取上游执行行）。 */
export function paramsDeclareUpstreamAlias(
  params: Record<string, unknown> | null | undefined,
): boolean {
  if (!params) return false;
  const walk = (node: unknown): boolean => {
    if (typeof node === "string")
      return parseUpstreamAliasSentinel(node) !== null;
    if (Array.isArray(node)) return node.some(walk);
    if (node !== null && typeof node === "object") {
      return Object.values(node).some(walk);
    }
    return false;
  };
  return walk(params);
}

/**
 * 深遍历判定 params 是否声明了 $upstream 哨兵（含 dot-path 变体）。
 * triggerDependentTasks 用它做**查询门**：本批下游无人 opt-in 时不读上游
 * 执行行——无声明场景连一笔查询都不产生（存量扇出逐字节零变化）。
 */
export function paramsDeclareUpstreamSentinel(
  params: Record<string, unknown> | null | undefined,
): boolean {
  if (!params) return false;
  const walk = (node: unknown): boolean => {
    if (typeof node === "string") {
      return (
        node === UPSTREAM_SENTINEL ||
        node.startsWith(`${UPSTREAM_SENTINEL}.`) ||
        parseUpstreamAliasSentinel(node) !== null
      );
    }
    if (Array.isArray(node)) return node.some(walk);
    if (node !== null && typeof node === "object") {
      return Object.values(node).some(walk);
    }
    return false;
  };
  return walk(params);
}

/**
 * 深遍历 params，把哨兵字符串替换为上游上下文（整对象或 dot-path 取值）。
 * 未命中任何哨兵时**返回原引用**（调用方据此判定"未注入"），命中时返回
 * 深拷贝后的新对象。ctx 内的 Date 原样保留（jsonb 序列化由驱动统一处理）。
 */
export function injectUpstreamContext(
  params: Record<string, unknown> | null | undefined,
  ctx: UpstreamExecutionContext | null,
  aliases: Record<string, UpstreamExecutionContext | null> = {},
): Record<string, unknown> | null {
  if (!params) return null;
  let touched = false;
  const resolvePath = (
    root: UpstreamExecutionContext,
    path: string,
  ): unknown => {
    let cur: unknown = root;
    for (const seg of path.split(".")) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        cur = null;
        break;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur === undefined ? null : cur;
  };
  const resolveString = (value: string): unknown => {
    const alias = parseUpstreamAliasSentinel(value);
    if (alias) {
      const root = aliases[alias.alias] ?? null;
      if (!root) return null;
      return alias.path === null ? root : resolvePath(root, alias.path);
    }
    if (!ctx) return SENTINEL_SKIP;
    if (value === UPSTREAM_SENTINEL) return ctx;
    if (value.startsWith(`${UPSTREAM_SENTINEL}.`)) {
      let cur: unknown = ctx;
      for (const seg of value.slice(UPSTREAM_SENTINEL.length + 1).split(".")) {
        if (cur === null || cur === undefined || typeof cur !== "object") {
          cur = null;
          break;
        }
        cur = (cur as Record<string, unknown>)[seg];
      }
      return cur === undefined ? null : cur;
    }
    return SENTINEL_SKIP;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const resolved = resolveString(node);
      if (resolved !== SENTINEL_SKIP) {
        touched = true;
        return resolved;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  const replaced = walk(params) as Record<string, unknown>;
  return touched ? replaced : params;
}

/**
 * R6: PG 唯一约束/主键冲突（SQLSTATE 23505 unique_violation）。客户端自带
 * 已存在的 id 时 insert 撞主键，驱动抛 QueryFailedError——若不拦截会经全局
 * 过滤器裸 500。识别后统一转 409 ConflictException。
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === "23505"
  );
}

/**
 * 技术债 A 组（2026-10-01）：从 23505 错误提取命中的**约束名**。TypeORM 的
 * QueryFailedError 会把驱动错误的自有属性拷贝到自身（QueryFailedError.js 里
 * ObjectUtils.assign(this, otherProperties)），pg 驱动错误自带 `constraint`
 * 字段——据此区分「撞主键」与「撞业务唯一索引」，给并发窗口下的写面冲突
 * 配上可读的 409 文案（而非笼统的 conflict）。
 */
function uniqueConstraintName(err: unknown): string | null {
  if (!(err instanceof QueryFailedError)) return null;
  return (err as QueryFailedError & { constraint?: string }).constraint ?? null;
}

/**
 * python_task_multiversion（WS1 · CONTRACT §2.5 / D14）：解释器不可获取的
 * 兜底分类判据（`inferFailureReason` 的**第一条**规则）。
 *
 * 为什么必须是第一条（实测驱动，非风格偏好）：
 * - **必须先于 timeout 规则**：解释器**下载**失败的真实文案天然含
 *   "timeout"/"timed out"（如 `interpreter download timeout after 300s`），
 *   若让既有 timeout 规则先跑，这类失败会被吞成 TIMEOUT——而下载超时是
 *   **环境/解释器**问题（运维处置：预填缓存卷或修镜像），与任务执行超时
 *   （处置：调 timeout / 查任务本身）是完全不同的两件事，分因错了等于把
 *   运维引向错误的排查方向。
 * - **必须先于 dependency 规则**：`uv venv failed: No interpreter found for
 *   Python 3.7` 含 "uv venv"（与依赖安装同一包装层），但根因是解释器缺失，
 *   不是依赖装不上。
 *
 * 语义边界（只认"解释器不可用"的**明确**措辞，绝不因包装层文案误判）：
 * - 任务自身代码仅仅打印了 "interpreter" 一词 → 不匹配（每条判据都要求
 *   解释器词与失败词**相邻**，孤立词不构成判据）。
 * - `uv venv failed: <其它原因>` → 不匹配（不因包装文案归类）。
 * - `uv pip install failed: ...` → 不匹配，仍归依赖/包类。
 * - 真实任务超时 `execution timed out after 300s` → 不匹配，仍归 TIMEOUT。
 *
 * 覆盖的实测文案（T01；桌面端内置 uv 由 0.8.17 升到 0.13.4 后**逐条复测**）：
 *   `No interpreter found for Python 3.7 in managed installations or search
 *    path`（`uv venv --python 3.7`，exit 2）
 *     ⚠️ 0.8.17 原文案尾部还有 `, or registry`，0.13.4 去掉了。判据只匹配
 *     前缀 `no interpreter found`，故版本差异不影响分类；此处按**当前**文案记录。
 *   `No download found for request: cpython-3.7-<platform>`（`uv python
 *    install 3.7`，exit 2）——0.8.17 与 0.13.4 逐字节一致
 *   `python downloads are set to 'manual'`（`UV_PYTHON_DOWNLOADS=manual`
 *    阻断隐式下载时的提示——本特性刻意设置该 env，故必然出现）
 *
 * 调用方传入的 text 已 `.toLowerCase()`；`[^\n]` 容差刻意不跨行，避免把
 * 日志里相隔很远的两个词误判为同一条失败。
 */
// F-01（本轮审计）: 由模块私有导出为公共常量——task.processor.ts 的派发失败
// 分类链（原先是自行抄写正则链）必须与这里的第一条规则**同一份判据**，否则两处
// 漂移会让 interpreter_unavailable 被误判成 EXECUTOR_OFFLINE（见 processor 注释）。
export const INTERPRETER_UNAVAILABLE_PATTERN = new RegExp(
  [
    // ① uv 的两条原始文案（措辞固定，最可靠）
    "no interpreter found",
    "no download found",
    "python downloads are set to",
    // ② 解释器词与"不可用/缺失"词相邻（英文；≤40 字符容差覆盖
    //    "interpreter 3.7 unavailable (cache miss + download failed)"）
    "interpreter[^\\n]{0,40}?(?:unavailable|not found|missing|unable)",
    "(?:unavailable|not found|missing|unable)[^\\n]{0,40}?interpreter",
    // ③ 解释器下载/安装失败（含 timeout 措辞）
    "interpreter[^\\n]{0,40}?(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)",
    "(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)[^\\n]{0,40}?interpreter",
    // ④ 中文：解释器 + 无法获取/不可用/缺失/找不到，或 解释器+下载+失败/超时
    "解释器[^\\n]{0,20}?(?:无法获取|不可用|不可获得|缺失|找不到)",
    "解释器[^\\n]{0,20}?下载[^\\n]{0,20}?(?:失败|超时)",
  ].join("|"),
);

/**
 * EXECUTOR_OFFLINE 的判据（**单一事实源**，F-01 同款纪律）。
 *
 * 为什么必须共用一份：同一条正则此前在 `task.service.ts::inferFailureReason`
 * （回调路径）与 `task.processor.ts`（派发失败路径）**各抄了一份**，于是
 * LANG-ERR-01 复查时同一个缺陷要修两遍——我先只修了 service 侧，CI 的 e2e
 * 用例 27 仍红（它走的是 processor 侧），正是"两处判据漂移"的现场。
 *
 * ## 容差为什么是 120 而不是 20（真实缺陷记录）
 *
 * 中文支原为 `执行器[^\n]{0,20}?…`，而中台自己产出的 pinned 离线文案是
 * `指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线`——「执行器→离线」
 * 间隔实测 **63 字符**（44 + appName 19；executorId 是 36 位 uuid）。20 的容差
 * **短于自家文案** → 规则不命中 → 归因落到 SCRIPT_ERROR：
 *   ① 用户在执行详情页看到「脚本错误」而非「执行器离线」，排障方向被带偏；
 *   ② SCRIPT_ERROR 在**默认重试集**里，白白消耗重试预算。
 *
 * 英文支 `executor.*(offline|unavailable)` 用无界 `.*` 故无此问题——中英容差
 * 不一致本身就是隐患。这里统一取**单行**足够大的界：`[^\n]` 才是真正的精度
 * 护栏（不跨行 ⇒ 不会把日志里相隔很远的两个词连起来，同上方解释器规则的理由）；
 * 同一行内同时出现「执行器」与「离线」几乎必然是离线归因。120 可覆盖 appName
 * 长达 ~56 字符，远超 appName 列宽。
 *
 * 回归护栏：`python-multiversion-write-path.spec.ts` 的
 * 「executor_offline 中文化回归」用例**用错误码表渲染真实文案**再断言分类
 * （回调路径），另有一条覆盖**派发路径**（task.processor）。
 */
export const EXECUTOR_OFFLINE_PATTERN =
  /executor.*(offline|unavailable)|no available executor|econnrefused|enotfound|network error|socket hang up|无可用执行器|没有可用(?:的)?执行器|执行器[^\n]{0,120}?(?:离线|不可用|不可达)/i;

/**
 * R63-A1（ADR-026 规则 4）：`rollbackToVersion` 允许从版本快照恢复的**列白名单**。
 *
 * 为什么是正向白名单，而不是「snapshot 里有什么就写什么」或整行 `save(entity)`：
 *
 * 1. **整行回写**（旧实现 `Object.assign(task, snapshot); taskRepo.save(task)`）
 *    写的是方法早期读到的快照——窗口内并发 PATCH 写下的 description /
 *    cronExpression、并发 pause 写下的 status、并发 remove 写下的
 *    status='deleted' + deletedAt 会被静默盖回（**软删行复活**）。回滚的语义是
 *    「把这一版的配置恢复回来」，不是「把这一行的时间线倒回读取那一刻」。
 * 2. 但快照恢复**确实**要覆盖一批列（不像 pause 只改 status），所以修法不是
 *    「只写一列」，而是「只写快照真的带了的列」——采纳集 = 白名单 ∩ 快照键。
 *    缺键保留现值的既有语义逐字不变（见 saveVersion 注释里的旧快照兼容说明），
 *    只是写面从「整行」收窄到「这些列」。
 * 3. **主键与框架列不在白名单里**：`version.snapshot` 带 `id` 只为可读性，
 *    把它写进 UPDATE 等于允许一次回滚改主键；createdAt / updatedAt / deletedAt
 *    是框架列，写它们会绕过乐观锁与软删语义。
 * 4. secrets / webhookSecret / status / ownerUserId 刻意**不**入快照（见
 *    saveVersion：版本端点会把 snapshot 原样回传，密文不能进版本历史），于是
 *    也不在白名单里——回滚永远不碰凭据与生命周期列。
 *
 * 维护约定：`saveVersion` 的 snapshot 键集新增一项，就必须在这里同步加一列；
 * `task.state-write-guards.spec.ts` 的「漂移钉子」会用真实 saveVersion 产出的
 * 快照反查本白名单的覆盖率，漏加即红。
 */
const VERSION_ROLLBACK_COLUMNS: readonly (keyof Task)[] = [
  "name",
  "description",
  "runtime",
  "entrypoint",
  "requirements",
  "params",
  "timeout",
  "timeoutAction",
  "timeoutWarnRatio",
  "estimatedDurationSec",
  "maxRetry",
  "retryDelay",
  "retryableErrors",
  "triggerType",
  "cronExpression",
  "timezone",
  "fixedRate",
  "blockStrategy",
  "misfireStrategy",
  "priority",
  "executeMode",
  "currentVersion",
  "gitRepo",
  "gitBranch",
  "gitCommit",
  "glueSource",
  "glueLanguage",
  "runtimeVersion",
  "codeSource",
  "applicationId",
  "maintenanceWindows",
  "runbook",
  "dependencies",
  "deploymentPolicy",
  "executorAffinityTags",
  "executorAntiAffinityTags",
  "executorId",
  "executorAppName",
  "executorGroup",
  "executorTags",
  "projectId",
  "alarmEmail",
  "alarmChannels",
];

@Injectable()
export class TaskService implements OnModuleInit {
  private readonly logger = new Logger(TaskService.name);
  /** Lazily-initialized optional S3/MinIO log backend (LOG_STORAGE_DRIVER=s3). */
  private s3LogStorage: S3LogStorage | null = null;
  private s3StorageResolved = false;

  /**
   * R7 (N17): pinning 与 broadcast 语义互斥——broadcast = "所有在线执行器"，
   * pinning = "仅此一个"，同时成立无法调和。抽成独立断言，供 create（请求体
   * 两键齐全）与 update（合并后的实体态）复用，保证消息一致。
   */
  private assertPinBroadcastExclusive(
    executorId?: string | null,
    executeMode?: ExecuteMode,
  ): void {
    if (executorId && executeMode === ExecuteMode.BROADCAST) {
      throw new AppError("TASK_PIN_BROADCAST_EXCLUSIVE");
    }
  }

  /**
   * A-1（执行器域审计 P1）：broadcast 与互斥组互斥——写面直接 400 拒绝。
   *
   * 背景：互斥组挂在**应用**上（applications.mutexGroupId），执行行创建时经
   * resolveTaskMutexGroupId 快照带下；dispatchBroadcast 派发时全程不调
   * claimExecutorSlotForExecution 占坑闸，「broadcast + 应用挂互斥组」的任务
   * 会静默绕过组内并发约束（同一秒 N 台全跑）。广播的语义就是"同时扇出全部
   * 在线执行器"，与互斥"组内串行/限并发"在调度语义上不可调和（单执行行的
   * 占用标记 executorAddress 无法表达 N 目标并发，强行占坑会破坏唤醒/释放
   * 链路），故选择在**写面拒绝**而不是运行时半吊子执行：任务创建/编辑时
   * 声明 broadcast 且其应用挂有互斥组 → 400。
   *
   * 判定对象是 applicationId 指向应用的当前组配置；应用不存在 → 无互斥组
   * （与 resolveTaskMutexGroupId 的「组查不到 = 不参与互斥」同口径，应用的
   * 存在性由 zip 渠道校验/派发链各自负责，不在此重复报错）。
   */
  private async assertBroadcastMutexCompatible(
    executeMode: ExecuteMode | null | undefined,
    applicationId: string | null | undefined,
    context: string,
  ): Promise<void> {
    if (executeMode !== ExecuteMode.BROADCAST) return;
    if (!applicationId) return;
    const appRepo = this.dataSource.getRepository(Application);
    const app = await appRepo
      .findOne({
        where: { id: applicationId },
        select: { id: true, name: true, mutexGroupId: true },
      })
      .catch(() => null);
    if (!app?.mutexGroupId) return;
    throw new AppError("TASK_BROADCAST_MUTEX_INCOMPATIBLE", {
      appName: app.name,
      appId: applicationId,
      mutexGroupId: app.mutexGroupId,
      context,
    });
  }

  /**
   * python_task_multiversion（FR-06 / AC-06b / NFR-05）：`runtimeVersion`
   * 写面校验——**格式 + 区间 + runtime 一致性**。
   *
   * 只做静态校验，**刻意不做**执行器缓存预检（AC-06c）：解释器"先下载后有"，
   * 首跑获取失败在运行时体现（分因 `interpreter_unavailable`，D14 明确失败）。
   * 写面若预检就等于把"先下载后有"变成同步依赖，且多执行器缓存不一致时判定
   * 必然失真。
   *
   * 校验对象是**合并后终态**（create = 请求体；PATCH = 旧行 + 增量），故
   * "非 python runtime 不得声明版本"能被正确判定——增量 DTO 看不到旧行的
   * runtime（先例：assertPinBroadcastExclusive 的 R7/N17 合并态兜底）。
   *
   * NFR-05 边界：空值（undefined/null/空串）一律放行——存量任务与不声明版本
   * 的路径零行为变化。`""` 视为"未声明"而非非法格式（历史数据/表单清空）。
   */
  private assertRuntimeVersionValid(
    runtimeVersion: string | null | undefined,
    runtime: TaskRuntime | string | null | undefined,
  ): void {
    if (runtimeVersion === null || runtimeVersion === undefined) return;
    // 空串 = 未声明（表单清空/存量脏值），不是"非法格式"——放行并交由
    // 既有语义处理（执行器侧按 falsy 走缺省解释器，AC-10a 逐字节不变）。
    if (typeof runtimeVersion === "string" && runtimeVersion.trim() === "") {
      return;
    }
    if (!isValidRuntimeVersionFormat(runtimeVersion)) {
      // 与 DTO 的 @Matches 同源判据（RUNTIME_VERSION_PATTERN）；service 层
      // 兜底覆盖内部调用方（application.service 自动注册 / 模板 / 回滚），
      // 它们绕过全局 ValidationPipe。
      throw new AppError("TASK_RUNTIME_VERSION_UNSUPPORTED", {
        detail: buildUnsupportedVersionMessage(runtimeVersion),
      });
    }
    // runtime 缺省 = 实体列默认值 python（`@Column({ enum: TaskRuntime,
    // default: TaskRuntime.PYTHON })`）——create 不传 runtime 时不得误判为
    // "非 python"。显式 null 同款处理（实体列为 NOT NULL，落库仍按既有行为
    // 报错，本校验不改变该失败面）。
    const effectiveRuntime = runtime ?? TaskRuntime.PYTHON;
    if (effectiveRuntime !== TaskRuntime.PYTHON) {
      throw new AppError("TASK_RUNTIME_VERSION_REQUIRES_PYTHON", {
        runtime: String(effectiveRuntime),
      });
    }
    if (!isRuntimeVersionSupported(runtimeVersion)) {
      throw new AppError("TASK_RUNTIME_VERSION_UNSUPPORTED", {
        detail: buildUnsupportedVersionMessage(runtimeVersion),
      });
    }
  }

  /**
   * python_task_multiversion（FR-18 / FR-19 / AC-17b / AC-19a）：代码来源与
   * runtime 一致性的**合并终态**校验。
   *
   * ① 代码来源三选一互斥（FR-18 / AC-17b）：
   *    `gitRepo` / `glueSource` / `codeSource='application_zip'`（配 applicationId）
   *    恰好一种。`requirements`（PyPI）属**依赖型**渠道，可与任一来源并存
   *    （AC-18b）——故不参与互斥。
   *
   * ② `codeSource='application_zip'` 时 `applicationId` 必填（CONTRACT §2.1）。
   *
   * ③ FR-19 / AC-19a：整包上传（zip）来源要求被引用 Application 的 `runtime`
   *    与任务 `runtime` **一致**，不一致给明确配置错误（而非运行期莫名失败）。
   *    只对 `codeSource='application_zip'` 生效——存量"裸 applicationId"
   *    （应用部署清单自动注册，application.service 两条路径）不查库、不判定，
   *    否则会给既有部署链引入新的失败面（NFR-05/FR-06 零破坏）。
   *
   * **作用域门（NFR-05 关键）**：CONTRACT §2.1 的定语是"只约束新建/编辑"——
   * 规则只在**本次请求确实在编辑相关字段**时生效，否则既有任务会被新规则追溯
   * 而突然不可 PATCH。具体两个门：
   * - `touchesCodeSource`（请求体含 gitRepo/glueSource/applicationId/codeSource
   *   任一键）→ 才做互斥与声明自洽判定。存量行 gitRepo+glueSource 并存（历史
   *   `updateGlue` 不清 gitRepo 所致；迁移按 §2.1 优先级回填 codeSource='git'，
   *   glueSource 成死数据）只改 timeout 时必须仍可 PATCH。
   * - FR-19 另加 `touchesRuntime`：只改 runtime 也会把 (zip, runtime) 变成不
   *   一致态，故两侧任一变动都要校验。
   *
   * 注意这与"PATCH 看合并终态"并不矛盾：合并态是**判定对象**，作用域门决定
   * **是否判定**——两者正交，R7/N17 的漏判（旧行 broadcast + 增量 executorId）
   * 恰好因为增量确实编辑了互斥字段，仍然会被拦住。
   */
  private async assertCodeSourceConsistent(
    state: {
      gitRepo?: string | null;
      glueSource?: string | null;
      applicationId?: string | null;
      codeSource?: TaskCodeSource | null;
      runtime?: TaskRuntime | string | null;
    },
    opts: {
      /** 本次请求是否编辑了任一代码来源字段（create 恒 true）。 */
      touchesCodeSource: boolean;
      /** 本次请求是否编辑了 runtime（create 恒 true）。 */
      touchesRuntime: boolean;
      /** 报错上下文（"create" / "task <id>"）。 */
      context: string;
    },
  ): Promise<void> {
    const codeSource = state.codeSource ?? null;
    const hasGit = Boolean(state.gitRepo);
    const hasGlue = Boolean(state.glueSource);
    const isZip = codeSource === TaskCodeSource.APPLICATION_ZIP;

    // ② 显式声明 zip 来源却无 applicationId —— 自相矛盾，任何路径都拒
    // （不受作用域门约束：该组合只可能由本次声明产生，且必然导致派发拿不到
    // packageUrl）。
    if (isZip && !state.applicationId) {
      throw new AppError("TASK_CODE_SOURCE_ZIP_REQUIRES_APPLICATION", {
        context: opts.context,
      });
    }

    if (opts.touchesCodeSource) {
      const declaredChannels: string[] = [];
      if (hasGit) declaredChannels.push("gitRepo");
      if (hasGlue) declaredChannels.push("glueSource");
      if (isZip) declaredChannels.push("codeSource=application_zip");
      if (declaredChannels.length > 1) {
        throw new AppError("TASK_CODE_SOURCE_EXCLUSIVE", {
          channels: declaredChannels.join(", "),
        });
      }
      // 显式声明了 codeSource 时，终态必须与该声明自洽（不允许"声明 git 却
      // 只有 glueSource"这类漂移——否则读面按 codeSource 判定会与执行器实际
      // 选用的来源不一致）。
      if (codeSource !== null) {
        const consistent =
          (codeSource === TaskCodeSource.GIT && hasGit) ||
          (codeSource === TaskCodeSource.GLUE && hasGlue) ||
          (codeSource === TaskCodeSource.APPLICATION_ZIP &&
            Boolean(state.applicationId));
        if (!consistent) {
          throw new AppError("TASK_CODE_SOURCE_MISMATCH", {
            codeSource,
            hasGit: hasGit ? "set" : "empty",
            hasGlue: hasGlue ? "set" : "empty",
            hasApplicationId: state.applicationId ? "set" : "empty",
          });
        }
      }
    }

    // ③ FR-19 / AC-19a：仅对显式 zip 来源、且本次确实在编辑来源或 runtime 时
    // 做 runtime 一致性校验。
    if (!isZip || !state.applicationId) return;
    if (!opts.touchesCodeSource && !opts.touchesRuntime) return;
    // runtime 缺省 = 实体列默认值 python（与 assertRuntimeVersionValid 同款
    // 兜底）：create 不传 runtime 时 state.runtime 为 undefined，若直接与
    // app.runtime（'python'）比较会误报不一致——把正常路径判成配置错误。
    const effectiveRuntime = state.runtime ?? TaskRuntime.PYTHON;
    const appRepo = this.dataSource.getRepository(Application);
    const app = await appRepo.findOne({
      where: { id: state.applicationId },
      select: { id: true, runtime: true, name: true },
    });
    if (!app) {
      // 弱引用（无 FK 强约束）指向不存在的应用——执行器侧必然拿不到
      // packageUrl。早失败成 400，而不是派发期才炸。
      throw new AppError("TASK_CODE_SOURCE_APPLICATION_NOT_FOUND", {
        applicationId: state.applicationId,
      });
    }
    if (app.runtime !== effectiveRuntime) {
      throw new AppError("TASK_CODE_SOURCE_RUNTIME_MISMATCH", {
        appName: app.name,
        appRuntime: app.runtime,
        taskRuntime: String(effectiveRuntime),
      });
    }
  }

  private normalizeTaskDto<T extends CreateTaskDto | UpdateTaskDto>(dto: T): T {
    const normalized = { ...dto } as T & {
      timeout?: number;
      timeoutSeconds?: number;
      timeoutAction?: string | null;
      timeoutWarnRatio?: number | null;
    };
    if (normalized.timeoutSeconds !== undefined) {
      normalized.timeout = normalized.timeoutSeconds;
      delete normalized.timeoutSeconds;
    }
    // CORE-04: 超时策略字段在持久化边界归一化。timeoutAction 缺省 undefined
    // = PATCH 保留旧值（不写键）；显式 null = 回到缺省 kill（归一化为 null
    // 落库，读路径 normalizeTimeoutAction 再兜底）。timeoutWarnRatio 非
    // 0-90 整数一律归 null（未启用）——DTO @Min/@Max 之外的运行态防线。
    if (normalized.timeoutAction !== undefined) {
      normalized.timeoutAction =
        normalized.timeoutAction === null
          ? null
          : normalizeTimeoutAction(normalized.timeoutAction);
    }
    if (normalized.timeoutWarnRatio !== undefined) {
      normalized.timeoutWarnRatio = normalizeTimeoutWarnRatio(
        normalized.timeoutWarnRatio,
      );
    }
    // cron UX 统一：裸 n/step（如 12/20，POSIX 语义）在写边界等价改写为
    // node-cron 可注册的规范式（12-59/20）——DTO 门已按「规范化后校验」放行，
    // 这里保证**落库的永远是调度器可注册的形态**，调度注册（nodeCron.schedule）
    // 与维护窗口匹配（parseWindowCron）零特判。规范化语义上是严格等价展开，
    // 只改写形态；结构不可解析时 fail-closed 400（DTO 放行的输入到不了这里，
    // 属于对非 DTO 调用方的纵深防御）。维护窗口 start/end 同款处理——否则
    // 窗口 cron 会重演「存得进去、parseWindowCron 解析不了、窗口静默不生效」。
    if (
      normalized.cronExpression !== undefined &&
      normalized.cronExpression !== null
    ) {
      // 显式 null = 清空（PATCH 语义，@IsOptional 同样放行），不参与规范化
      normalized.cronExpression = this.assertNormalizableCron(
        normalized.cronExpression,
        "cronExpression",
      );
    }
    if (Array.isArray(normalized.maintenanceWindows)) {
      normalized.maintenanceWindows = normalized.maintenanceWindows.map(
        (w, i) => ({
          ...w,
          start: this.assertNormalizableCron(
            w.start,
            `maintenanceWindows[${i}].start`,
          ),
          end: this.assertNormalizableCron(
            w.end,
            `maintenanceWindows[${i}].end`,
          ),
        }),
      );
    }
    // W-21: requirements reach `uv pip install` / `npm install` as argv on
    // the executor. Reject option-shaped specs (`--index-url http://evil`
    // would hijack the package index) and blank entries here, mirroring the
    // executors' own guards so a bad spec 400s at create instead of burning a
    // queued execution. Trim normalizes harmless surrounding whitespace.
    if (Array.isArray(normalized.requirements)) {
      normalized.requirements = normalized.requirements.map((raw) => {
        const spec = typeof raw === "string" ? raw.trim() : raw;
        if (typeof spec !== "string" || spec.length === 0) {
          throw new AppError("TASK_REQUIREMENT_EMPTY");
        }
        if (spec.startsWith("-")) {
          throw new AppError("TASK_REQUIREMENT_OPTION_LIKE", { spec });
        }
        return spec;
      });
    }
    // R6: 请求体自身两键齐全时直接拒绝（create 路径覆盖此洞）。update 的
    // PATCH 合并路径由 assertPinBroadcastExclusive 在合并后实体态兜底（N17）。
    this.assertPinBroadcastExclusive(
      normalized.executorId,
      normalized.executeMode,
    );
    return normalized as T;
  }

  /**
   * cron 写边界规范化（见 normalizeTaskDto 内注释）。null（结构不可解析）
   * 属于「DTO 门不可能放行」的纵深防御分支：显式 400 拒绝，绝不静默落库
   * 调度器跑不了的表达式——那比 400 糟糕得多（存进去却永不触发）。
   */
  private assertNormalizableCron(value: unknown, field: string): string {
    const normalized = normalizeCron5Field(value);
    if (normalized === null) {
      throw new AppError("TASK_CRON_FIELD_INVALID", { field });
    }
    return normalized;
  }

  private inferFailureReason(
    errorMessage?: string | null,
    logs?: string | null,
    exitCode?: number,
  ): ExecutionFailureReason {
    const text = [errorMessage, logs].filter(Boolean).join("\n").toLowerCase();

    // python_task_multiversion（WS1 · CONTRACT §2.5 / D14）：解释器不可获取的
    // **兜底分类**——必须是**第一条**规则（判据与理由见模块级
    // INTERPRETER_UNAVAILABLE_PATTERN 注释）。
    //
    // 注意本方法只是**兜底**：回调自带 failureReason 时优先采信执行器分类
    // （下方调用点 `cb.failureReason ?? this.inferFailureReason(...)`），
    // 本规则服务于旧执行器与执行器未分类的失败。
    if (INTERPRETER_UNAVAILABLE_PATTERN.test(text)) {
      return ExecutionFailureReason.INTERPRETER_UNAVAILABLE;
    }

    // LANG-ZH-01（面向用户文字中文化）配套：以下分类正则**必须中英双语**。
    //
    // 为什么不能只留英文：执行器侧的用户可见文案正在中文化，若只改执行器产出的
    // 文案而不同步这里的关键词，失败分类会**静默失效**（全部落 UNKNOWN → 用户
    // 看到「未知原因」，且 TIMEOUT/INTERPRETER_UNAVAILABLE 这类「不进默认重试集」
    // 的语义会反转，白白烧重试预算）。
    //
    // 为什么也不能只留中文：① 存量执行器（未升级）与**已落库的历史 errorMessage**
    // 仍是英文，去掉英文支会让它们全部退化为 UNKNOWN；② 两侧是**独立发版**的
    // 进程，滚动升级期间必然新旧并存。故英中并列是唯一安全口径
    // （与 INTERPRETER_UNAVAILABLE_PATTERN 已有的中西双语写法同款）。
    if (
      /timeout|timed out|etimedout|execution timed|超时|执行已超时/.test(text)
    ) {
      return ExecutionFailureReason.TIMEOUT;
    }
    if (EXECUTOR_OFFLINE_PATTERN.test(text)) {
      return ExecutionFailureReason.EXECUTOR_OFFLINE;
    }
    if (
      /git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|module not found|cannot find module|拉取(?:应用包|依赖|代码)|克隆代码|下载(?:应用包|依赖|包)|依赖安装|安装依赖|代码拉取/.test(
        text,
      )
    ) {
      return ExecutionFailureReason.PACKAGE_FETCH_FAILED;
    }
    if (typeof exitCode === "number" && exitCode !== 0) {
      return ExecutionFailureReason.SCRIPT_ERROR;
    }
    if (
      /traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code|脚本(?:错误|异常)|命令执行失败/.test(
        text,
      )
    ) {
      return ExecutionFailureReason.SCRIPT_ERROR;
    }
    return ExecutionFailureReason.UNKNOWN;
  }

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(ExecutionLogLine)
    private logLineRepo: Repository<ExecutionLogLine>,
    @InjectRepository(TaskVersion) private versionRepo: Repository<TaskVersion>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private dataSource: DataSource,
    @Inject(forwardRef(() => SchedulerService))
    private schedulerService: SchedulerService,
    private aiService: AiService,
    // ARCH-30: AI 分析服务化封装（手动 analyzeExecution 路径消费）
    private aiAnalysisService: AiAnalysisService,
    private configService: ConfigService,
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套
    // （executor.module 注释）。
    @Inject(forwardRef(() => ExecutorService))
    private executorService: ExecutorService,
    // ARCH-21: 事件总线（@Global 模块恒提供）。@Optional 仅为既有单测装配
    // 兼容（provider 缺失 → null → 终态事件静默不发，主链行为不变），
    // 先例同 001/OBS-04 的 reportRepo。
    @Optional()
    private readonly eventBus: DomainEventBus | null,
    // ARCH-21: AuditService 注入已随 notifyCallbackFailure 迁出删除——其在
    // 本服务的唯一消费方（NOTIFICATION_FAILED 审计兜底）现由
    // notification 模块 ExecutionEventsListener 持有。
    // SEC-02: secrets 落库加密/读脱敏（providers 由 TaskModule 提供）
    private secretsCrypto: SecretsCryptoService,
    // OBS-01: OpenTelemetry 追踪（@Global 恒提供）。@Optional 仅为既有单测
    // 装配兼容（provider 缺失 → null → 全方法短路，与 disabled 等价），
    // 先例同 eventBus/reportRepo。
    @Optional()
    private tracing: TracingService | null,
    // OBS-04: execution_reports 读侧（只读——写方在 MetricsService）。
    // @Optional：既有单测模块（task.service.spec / s3 integration spec）
    // 未提供该仓储时回退 null，零破坏——report 端点在缺失时返回 null 行。
    @Optional()
    @InjectRepository(ExecutionReport)
    private reportRepo: Repository<ExecutionReport> | null,
    // TASK-PROJ-01: 归属项目存在性校验。@Optional 同上述先例——既有单测装配
    // 未提供该仓储时回退 null；此时 assertCanAssignProject 对非 ADMIN 一律拒绝
    // （不 fail-open，宁严不松），而默认的"不传 projectId"路径完全不受影响。
    @Optional()
    @InjectRepository(Project)
    private projectRepo: Repository<Project> | null,
    // AUTH-02: 项目级角色（ProjectAccessService）。@Optional 同上述先例——
    // provider 缺失（单测装配）时整体旁路，写面判定逐字节保持既有行为。
    @Optional()
    private projectAccess: ProjectAccessService | null,
    // R-28: 依赖触发系统动作审计（@Optional，先例 eventBus/projectAccess）。
    @Optional()
    private readonly audit: AuditService | null,
    // FIX-3.1: 超时预警消费面（@Optional —— 既有单测按位置传参的装配缺省
    // undefined 时预警静默跳过，主链零变化；生产装配 TaskModule providers /
    // NotificationModule export 均已提供）。
    @Optional()
    private readonly redisLockService?: RedisLockService | null,
    @Optional()
    private readonly notificationService?: NotificationService | null,
    // FIX-4.2: 终态唤醒发布侧（@Optional 同上；缺席时 webhook 等待退化为
    // 纯退避轮询，行为与引入前等价）。
    @Optional()
    private readonly executionWakeService?: ExecutionWakeService | null,
    // ARTIFACTS-INDEX-46: 产物元数据索引表写侧（终态回调 jsonb 清单与新表
    // 双轨写）。@Optional 同 reportRepo/projectRepo 先例——既有单测装配未提供
    // 该仓储时回退 null，此时新表不写、jsonb 主链逐字节不变（读面回落 jsonb）。
    @Optional()
    @InjectRepository(ExecutionArtifactRow)
    private readonly artifactIndexRepo?: Repository<ExecutionArtifactRow> | null,
  ) {
    // R-26（DEEP_REVIEW 0ef3bbe）: 关键 @Optional 依赖缺失时降级不可观测——
    // 事件总线/审计静默缺失会让终态事件不发、依赖触发审计不写。生产装配下这些
    // @Global provider 恒在；此处仅在缺失时一次性 warn，使静默降级在日志面可见
    // （每进程一次，不刷屏；单测装配缺 provider 时同样命中该观测面）。
    if (!this.eventBus) {
      this.logger.warn(
        "R-26: DomainEventBus 未装配——终态事件将静默不发（检查事件总线模块是否注册）",
      );
    }
    if (!this.audit) {
      this.logger.warn(
        "R-26: AuditService 未装配——依赖触发系统动作审计将静默不写（检查 AuditModule 是否导出）",
      );
    }
  }

  /**
   * NF-03（任务级 RBAC 预研）：写面属主守卫。三态语义：
   * - ADMIN 全量放行；
   * - 行 ownerUserId 为 NULL（无主/存量行）→ 仅 ADMIN（保守默认，方向安全）；
   * - ownerUserId 非 NULL 且 ≠ 当前用户 → 403（悬垂 id 同样按非本人处理）。
   * 只拦 update/remove 等配置写面；trigger 等执行类写面不在预研范围
   * （见 NF-03 认领行缩水声明）。user 为 null（API-Key 主体等）按非 ADMIN。
   */
  assertCanWrite(
    row: { ownerUserId: number | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): void {
    // A2-B: 先落证再判定——「判定过」本身就是证据（ADMIN 放行同样是授权决策），
    // 落证在放行分支之前，保证任何分支都留下痕迹。HTTP 请求外为 no-op。
    recordOwnershipAssertion("task", "write");
    if (user?.role === UserRole.ADMIN) return;
    if (row.ownerUserId === null) {
      throw new AppError("TASK_HAS_NO_OWNER");
    }
    if (row.ownerUserId !== user?.id) {
      throw new AppError("TASK_NOT_OWNER");
    }
  }

  /**
   * AUTH-02: 在 NF-03 属主守卫之上叠加**项目角色放行**（只增放行、不收紧）。
   *
   * 项目 editor/admin 可写该项目内的任务——含他人创建的行与无主（存量）行，
   * 这是团队协作形态的真实缺口（此前只有 ADMIN 与属主本人能改）。viewer 与
   * 非成员维持「属主守卫」原判定，绝不因本方法新增任何拒绝。
   * ProjectAccessService 缺席（单测/未接线）时与 assertCanWrite 完全等价。
   */
  async assertCanWriteProjectAware(
    row: { ownerUserId: number | null; projectId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): Promise<void> {
    try {
      this.assertCanWrite(row, user);
      return;
    } catch (e: unknown) {
      if (!(e instanceof ForbiddenException)) throw e;
      if (!this.projectAccess || !user?.id) throw e;
      const allowed = await this.projectAccess.hasProjectRole(
        user.id,
        row.projectId ?? null,
        "editor",
      );
      if (!allowed) throw e;
    }
  }

  /**
   * AUTH-02 + TASK-SCOPE-01: 执行类写面（trigger/pause/resume）归属。
   *
   * 两层语义：
   *  1. **始终拒绝项目 viewer**（AUTH-02 硬约束，与开关无关）—— viewer 的定义
   *     即只读，这是角色模型唯一的硬约束点；
   *  2. **可选收紧到属主/项目 editor**（TASK-SCOPE-01，经 `TASK_OPERATE_SCOPE`
   *     配置）：默认 `any` 保留既有「任何已登录用户可 trigger」的宽松语义（零
   *     行为变化，ADR-013 登记的已知缺口）；置为 `owner` 后，只有 ADMIN、任务
   *     属主、或该项目内 editor 及以上角色可以操作。
   *
   * 为什么做成开关：这是行为变更，硬改会让现有依赖"我能跑同事任务"的团队全体撞
   * 403。给运维显式选择权比单方面替他们决定更稳妥。
   */
  async assertCanOperate(
    row: { ownerUserId: number | null; projectId?: string | null },
    // A-6（R3-A 审计）: 放宽入参形状——API-Key 主体（ApiKeyUser）只带
    // userId 不带 id/role，此前签名把它排除在属主判定之外。
    user: { id?: number; userId?: number; role?: UserRole } | null | undefined,
  ): Promise<void> {
    // A-6: 属主判定/放行兜底按 `id ?? userId` 归一主体 id——ApiKeyUser 只有
    // userId，旧代码 `user?.id` 恒 undefined：owner 档属主分支被跳过、再经
    // 下方放行兜底（!user?.id → return）直接放行，trigger/manage scope 的
    // key 可无视 TASK_OPERATE_SCOPE=owner 触发任意任务。归一后 API-Key 按
    // 其 key 属主 userId 参与属主/项目角色判定；JWT 用户（id 恒有值）行为
    // 逐字节不变，user 为 null 的内部调用同样维持既有旁路。
    const principalId = user?.id ?? user?.userId;

    // SEC-R3-5（第 3 轮安全审计）：**主体缺失的内部调用不落证**。
    //
    // 旧实现把 `recordOwnershipAssertion("task","operate")` 放在第一行，于是
    // `assertCanOperate(row, null)`（webhook 触发等机器面）会在**没有做任何
    // 判定**的情况下留下「已校验」证据。当前 webhook 路由是 scope:"public"
    // 不需要该证据，所以不可利用；但只要将来有一条 project-role 路由复用
    // `trigger(...)` 而漏传 user（R-02 已发生过两次真实漏传），A2-B 拦截器
    // 会读到这条假证据并放行——缺省拒绝的强制点失效。
    //
    // 证据的语义应是「判定为允许」（OPA/Cedar 的 decision log 只记结论），
    // 不是「进过这个函数」。主体缺失属于「无法判定」：保留既有旁路（机器面
    // 行为零变化）但不留证——真被 project-role 路由漏传时拦截器会拒绝。
    if (principalId === undefined) return;

    // A2-B: 落 'operate' 证（区别于 'write'）——本方法只拒 viewer / 可选的属主
    // 校验，落同一种证据会让 project-role 端点冒充 ownership。落证在主体缺失
    // 判定之后、其余分支（含拒绝分支）之前：拒绝分支本就以异常收尾，拦截器
    // 的 next 不会被调用，证据不会造成放行。
    recordOwnershipAssertion("task", "operate");

    // TASK-SCOPE-01: `owner` 档在既有 viewer 拒绝之上叠加属主判定。
    // 与 assertCanWriteProjectAware 同款姿态：先试属主/项目 editor，不通即拒。
    if (this.isOperateScopeOwner() && principalId !== undefined) {
      const allowed = await this.canOperateAsOwner(row, {
        id: principalId,
        role: user?.role,
      });
      if (!allowed) {
        throw new AppError("TASK_OPERATE_SCOPE_OWNER");
      }
      return;
    }

    if (!this.projectAccess || principalId === undefined) return;
    if (user?.role === UserRole.ADMIN) return;
    // R32-B1（fail-closed）：判定是**三态**的，先回答「判定到底做完了没有」。
    // 旧代码在这里直接拿二态 `resolveRole`：DB 抖动 → null → 与「非成员」同形 →
    // 下面的 `role === "viewer"` 不成立 → 函数自然返回 = **放行**。也就是说权限
    // 检查在故障窗口里不存在（R32-A5 登记的 fail-open）。
    const resolution = await this.resolveOperateRoleState(
      principalId,
      row.projectId ?? null,
    );
    if (resolution.status === "unavailable") {
      // 判定没做完 ≠ 没有权限关系。对执行类写面唯一安全的答案是拒绝，且必须是
      // 503（依赖暂时不可用、重试即可）而不是 403——403 会把用户引向"找管理员
      // 申请权限"，而他的权限其实一直都在，只是这一秒查不到。
      throw new AppError(ErrorCode.PROJECT_ROLE_UNAVAILABLE);
    }
    if (resolution.status === "role" && resolution.role === "viewer") {
      throw new AppError("TASK_OPERATE_VIEWER_READONLY");
    }
  }

  /**
   * TASK-PROJ-01（本轮审计）：任务归属项目的写入校验。
   *
   * 背景：`tasks.projectId` 列由迁移 1790000000008 建立并回填了**存量**任务，但
   * 该迁移注释写明「新建任务在 DTO 未接 projectId 前一律落 NULL」——收尾项一直
   * 没做。于是新建任务永远 NULL，而 project-access.service 把 NULL 按
   * DEFAULT_PROJECT_ID 判定，「项目隔离」对所有新任务都塌缩到默认项目、形同虚设。
   *
   * 本方法只做两件事，且**都是纯增量**（不填 projectId 的老调用方零影响）：
   *  1. 传了具体 UUID → 校验项目**真实存在**（否则 FK 违例会变成裸 500）；
   *  2. 校验调用方**有权把任务放进该项目** —— ADMIN，或该项目的 editor/admin。
   *     否则任何人都能把自己的任务塞进别人的项目（或把任务从别人项目里"捞走"），
   *     归属校验就形同虚设。
   *
   * 省略 / null 一律放行：语义是"未分配"，读面归入默认项目视图，与既有行为一致。
   */
  private async assertCanAssignProject(
    projectId: string | null | undefined,
    user: { id: number; role?: UserRole } | null | undefined,
  ): Promise<void> {
    if (projectId === null || projectId === undefined) return;

    // 1) 存在性：早失败成 400，而不是让 FK 违例冒成 500
    if (!this.projectRepo) {
      // 仓储缺席（既有单测装配）——无法校验存在性，故拒绝而非放行（宁严不松）。
      throw new AppError("TASK_PROJECT_UNSUPPORTED");
    }
    const exists = await this.projectRepo.findOne({
      where: { id: projectId },
      select: { id: true },
    });
    if (!exists) {
      throw new AppError("TASK_PROJECT_NOT_FOUND", { projectId });
    }

    // 2) 授权：ADMIN 无条件；其余须为该项目 editor/admin
    if (user?.role === UserRole.ADMIN) return;
    if (!user?.id) {
      // 无用户主体（内部/机器调用且非 ADMIN）——不允许改归属，避免绕过授权。
      throw new AppError("TASK_PROJECT_ASSIGN_ADMIN_ONLY");
    }
    if (!this.projectAccess) {
      // 项目权限服务缺席：与 assertCanWriteProjectAware 同款姿态——不 fail-open，
      // 退化为「仅 ADMIN 可设置」（上面已放行 ADMIN）。
      throw new AppError("TASK_PROJECT_ASSIGN_ADMIN_ONLY");
    }
    // R32-B1 的最后一处残余（本批）：这里此前仍走**二态** `resolveRole` —— DB
    // 抖动 ⇒ null ⇒ 与「非成员」同形 ⇒ 403 TASK_PROJECT_ASSIGN_FORBIDDEN。
    // 方向上是 fail-closed（不越权），但结论是错的：用户的权限一直都在，只是这一
    // 秒查不到，403 会把他引向「找管理员申请权限」。改为三态：
    // unavailable ⇒ 503 PROJECT_ROLE_UNAVAILABLE（可重试），
    // none / viewer ⇒ 403（语义未变）。
    const resolution = await this.resolveOperateRoleState(user.id, projectId);
    if (resolution.status === "unavailable") {
      throw new AppError(ErrorCode.PROJECT_ROLE_UNAVAILABLE);
    }
    const role = resolution.status === "role" ? resolution.role : "none";
    if (role !== "editor" && role !== "admin") {
      throw new AppError("TASK_PROJECT_ASSIGN_FORBIDDEN");
    }
  }

  /** TASK-SCOPE-01: 读配置判定执行类写面是否收紧到属主口径。 */ private isOperateScopeOwner(): boolean {
    try {
      // 审计 E-P1-S1：configuration.ts 对未设置 env 现在默认返回 "owner"，
      // 故未配置即收紧；仅运维显式 TASK_OPERATE_SCOPE=any 才走宽松档。
      return this.configService?.get<string>("taskScope.operate") === "owner";
    } catch {
      // 配置读取异常按收紧处理（安全缺省，与翻转后的默认一致）——配置抖动
      // 不再 fail-open 成「任意登录用户可操作任意任务」。
      return true;
    }
  }

  /**
   * TASK-SCOPE-01: `owner` 档的放行判定 —— ADMIN / 属主 / 项目 editor 及以上。
   * projectAccess 缺席（单测或未接线）时退化为「ADMIN 或属主」，不 fail-open。
   */
  private async canOperateAsOwner(
    row: { ownerUserId: number | null; projectId?: string | null },
    // A-6: role 可缺省——API-Key 主体没有 role（undefined ≠ ADMIN，
    // 语义即「API-Key 不享有 ADMIN 短路」），属主/项目角色判定不受影响。
    user: { id: number; role?: UserRole },
  ): Promise<boolean> {
    if (user.role === UserRole.ADMIN) return true;
    if (row.ownerUserId !== null && row.ownerUserId === user.id) return true;
    if (!this.projectAccess) return false;
    // R32-B1：owner 档同样走三态。旧代码把「判定不可用」折成 null 后按非成员
    // 拒绝——方向上已经是 fail-closed（不会放行），但给出的结论是错的：数据库
    // 抖动窗口里用户会收到 403「你不是该任务的属主」，而真实原因与他的权限无关。
    // 这里只把 unavailable 这一支从 403 改成 503，其余分支逐字节不变。
    const resolution = await this.resolveOperateRoleState(
      user.id,
      row.projectId ?? null,
    );
    if (resolution.status === "unavailable") {
      throw new AppError(ErrorCode.PROJECT_ROLE_UNAVAILABLE);
    }
    // editor / admin 放行；viewer 与「非成员」（status: "none"）拒绝。
    return (
      resolution.status === "role" &&
      (resolution.role === "editor" || resolution.role === "admin")
    );
  }

  /**
   * R32-B1：执行类写面的三态判定入口（`assertCanOperate` 与其 owner 档分支共用）。
   *
   * 为什么不直接调 `this.projectAccess.resolveRoleState`：本仓三处既有单测把
   * projectAccess 铸成 `{ hasProjectRole, resolveRole }` 这样的**二态替身**
   * （`modules/api-keys/__tests__/api-key-owner-scope.spec.ts`、
   * `common/guards/__tests__/ownership-assertion-recording.spec.ts` 等），
   * 它们对「查询失败」没有表达能力。故对这类替身退化为二态折叠（与改动前逐字节
   * 一致）；**生产装配注入的是真实的 ProjectAccessService**，永远命中三态分支。
   * 这条不变量由 `__tests__/task-operate-role-unavailable.spec.ts` 用真服务钉住
   * （它同时断言替身路径仍然可用，防止"垫片"变成新的静默降级点）。
   */
  private async resolveOperateRoleState(
    userId: number,
    projectId: string | null,
  ): Promise<ProjectRoleResolution> {
    const access: {
      resolveRoleState?: ProjectAccessService["resolveRoleState"];
      resolveRole: ProjectAccessService["resolveRole"];
    } = this.projectAccess as never;
    if (typeof access.resolveRoleState === "function") {
      return access.resolveRoleState(userId, projectId);
    }
    const role = await access.resolveRole(userId, projectId);
    return role === null || role === undefined
      ? { status: "none" }
      : { status: "role", role };
  }

  /**
   * A2-B：执行记录（`task_executions` 行）写面的属主校验。
   *
   * 供 killExecution / analyzeExecution 等「按 executionId 操作」的写面复用——
   * 这两个端点此前完全不做属主校验（任意登录用户可终止他人任务的执行），
   * 而它们声明的 scope 是 `ownership`；A2-B 的运行时强制把它们暴露出来了。
   *
   * 判定对象上提到 execution 所属的 **task** 行（属主语义只在 task 上）：
   * - execution.taskId 缺失 → 403（拿不到归属，保守拒绝，不退化成放行）；
   * - task 行不存在 → 404（悬垂 execution，与既有「Execution not found」同档）。
   */
  private async assertCanWriteExecution(
    execution: { taskId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): Promise<void> {
    if (!execution.taskId) {
      throw new AppError("TASK_EXECUTION_SCOPE_UNKNOWN");
    }
    const task = await this.taskRepo.findOne({
      where: { id: execution.taskId },
    });
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", {
        taskId: execution.taskId,
      });
    }
    await this.assertCanWriteProjectAware(task, user);
  }

  async create(dto: CreateTaskDto, user?: { id: number } | null) {
    // FEAT-RENAME：名称的服务层守卫。
    //
    // 为什么 DTO 的 @IsTaskName 不够：create() 有一批**编程式调用方**绕过
    // 全局 ValidationPipe——最典型的是 application.service 的 manifest.json
    // 自动注册（`name: taskDef.name || taskDef.id`，直接构造对象调 create）。
    // 没有本守卫时，manifest 里的名字可以带首尾空白/控制字符（进日志行与
    // 通知标题），或超过 255 字符 → PG 报 22001 → 笼统 500。
    //
    // 与本文件既有的 assertRuntimeVersionValid / assertTriggerConfigConsistent
    // 同一纪律（见 548 行注释：服务层守卫存在的理由正是这些内部调用方）。
    const nameProblem = describeTaskNameProblem(dto?.name);
    if (nameProblem) {
      throw new AppError("TASK_NAME_UNAVAILABLE", {
        reason: nameProblem,
      });
    }
    if (dto.dependencies && Object.keys(dto.dependencies).length > 0) {
      // FIX-1.1（依赖链契约）：先校验 value 是真实存在的任务 id——value 是
      // 扇出/环检测的**语义位**，坏 value 必须在写面 400，而不是落库后
      // 让 checkDependencies 永远判不满足（旧契约 {taskId: name} 就是这么
      // 静默失效的）。环/自依赖检测在其后（value=id 后既有代码自然生效）。
      await this.assertDependencyValuesExist(dto.dependencies);
      await this.checkCircularDependency(dto.id, dto.dependencies);
    }
    const normalized = this.normalizeTaskDto(dto);
    // FIX-1.3: triggerType 与触发配置配对校验（cron ⇒ cronExpression、
    // fixed_rate ⇒ fixedRate≥1）。此前缺校验：API/MCP/自动注册路径可创建
    // 「active 但永不触发」的任务且无任何告警（调度注册条件不满足即静默跳过，
    // misfire 补偿又因 lastTriggerTime 恒空而永久失明）。
    this.assertTriggerConfigConsistent(normalized);
    // python_task_multiversion（FR-06/FR-18/FR-19）：create 路径的终态就是
    // 请求体本身，直接校验。顺序刻意在归属/SSRF 守卫之后、落库之前——保证
    // 既有守卫的报错优先级与消息零变化（既有用例断言 file:// 被拒且不落库）。
    this.assertRuntimeVersionValid(
      normalized.runtimeVersion,
      normalized.runtime,
    );
    // create 的终态就是请求体，作用域门恒 true（全量字段即本次编辑面）。
    await this.assertCodeSourceConsistent(normalized, {
      touchesCodeSource: true,
      touchesRuntime: true,
      context: "create",
    });
    // TASK-PROJ-01: 归属项目校验（存在性 + 授权），见 assertCanAssignProject
    await this.assertCanAssignProject(normalized.projectId, user);
    // A-1: create 的终态就是请求体——broadcast + 应用挂互斥组在写面直接 400
    //（派发面 dispatchBroadcast 不执行互斥占坑，见方法头注）。
    await this.assertBroadcastMutexCompatible(
      normalized.executeMode,
      normalized.applicationId,
      "create",
    );
    // SEC-NEW-2 对齐（W-21 后续）：git 源在**任务写面**即校验。executor 派发时只放行
    // https?://|git@|ssh:// 且拒绝 loopback/私有网段（execute.ts:363-376，python 侧对等）
    // ——此前 admin 不做同类校验，导致「任务创建成功、派发才 400」的两端不一致。
    // 复用部署链同一实现（application.service 亦用 assertSafeGitRepoUrl）。
    if (normalized.gitRepo) {
      await assertSafeGitRepoUrl(normalized.gitRepo);
    }
    // NF-03: 创建即落 owner（含 ADMIN 创建——可追溯，也为 AUTH-02 读面预铺）。
    // normalized 是 CreateTaskDto 形态，ownerUserId 在实体列上——save 前并入。
    (normalized as unknown as Record<string, unknown>)["ownerUserId"] =
      user?.id ?? null;
    // SEC-02: secrets 在持久化边界统一加密（key 未配置时降级明文并 warn）
    normalized.secrets = this.secretsCrypto.encryptForStorage(
      normalized.secrets,
    ) as Record<string, unknown> | null | undefined;
    // R6: 客户端自带 id 时先查重——软删除行对普通 findOne 不可见但同样
    // 占用主键，必须 withDeleted；预检查之外，save 处仍兜底捕获 23505
    //（覆盖并发创建的 TOCTOU 窗口），两者都返回 409 而非裸 500。
    if (normalized.id) {
      const existing = await this.taskRepo.findOne({
        where: { id: normalized.id },
        withDeleted: true,
      });
      if (existing) {
        // LANG-ZH-01 / LANG-ERR-01：本消息同时被
        // `application.service.ts` 的清单自动注册路径以 `.includes("已存在")`
        // 判据识别为「正常跳过」，故迁移到错误码后渲染出的 `zh` **仍然必须
        // 含「已存在」**（`TASK_ID_EXISTS.zh` = 任务 ID「{{id}}」已存在 ✓）
        // ——否则「任务已存在」这个正常场景会被记成 error 级故障。
        throw new AppError("TASK_ID_EXISTS", { id: normalized.id });
      }
    }
    try {
      const saved = await this.taskRepo.save(this.taskRepo.create(normalized));
      await this.saveVersion(saved.id, undefined, undefined, saved);
      // F-4（SEC-02 安全红线）：create 是写路径唯一漏脱敏的返回点——
      // update/pause/resume/updateGlue/findOne 全部经 maskSecretsForResponse，
      // 契约是「API 读取永久脱敏（叶子值回 ******）」。save 返回的是含
      // 明文/密文的原始行，控制器原样回传会把真实凭据带给调用方（并随审计
      // 日志/代理日志落盘）。importDefinition 复用本方法，其响应只取
      // taskId/name，一并覆盖。
      return this.maskSecretsForResponse(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // 技术债 A 组（2026-10-01）：迁移 1790000000050 起 tasks.name 有唯一
        // 索引 idx_tasks_name_unique——预检查窗口外的**并发同名创建**在此落网，
        // 按约束名分流给可读文案（其余唯一冲突维持 R6 既有口径）。
        if (uniqueConstraintName(err) === "idx_tasks_name_unique") {
          throw new AppError("TASK_NAME_EXISTS", {
            name: normalized.name,
          });
        }
        throw normalized.id
          ? new AppError("TASK_ID_EXISTS", { id: normalized.id })
          : new AppError("RESOURCE_EXISTS");
      }
      throw err;
    }
  }

  // ── E-1: 任务定义导入/导出 ──────────────────────────────────────────────
  // 纯逻辑在 task-definition.util.ts（白名单装配/映射/后缀推导，可独立单测）；
  // 本服务层只负责取数、复用 create 链路与重名冲突重试。

  /**
   * E-1: 任务定义导出——返回可下载 JSON 的 payload 与文件名。
   *
   * 取数走既有脱敏读路径 findOne（secrets 先被掩码）+ 导出白名单整键剔除
   * + assertNoSecretMaterial 运行时不变量（/secret/i 键名命中即 fail-closed）
   * ——三层防线保证 SEC-02 红线：secrets 值与键名 alike 绝不出现在导出物中。
   * 权限语义与 GET /tasks/:id 读面完全一致（控制器类级 JwtAuthGuard）。
   */
  async exportDefinition(id: string): Promise<TaskExportResult> {
    const task = await this.findOne(id);
    return buildTaskExportResult(task);
  }

  /**
   * E-1: 任务定义导入——导出物映射回 CreateTaskDto 后复用 create 链路
   * （DTO 校验在 HTTP 边界由 ImportTaskDto→CreateTaskDto 嵌套完成，normalize/
   * 触发配置配对/代码来源互斥/归属校验等由 create 全量执行）。
   *
   * 名称冲突策略：**绝不覆盖同名任务**。create 只在名称唯一索引
   * （idx_tasks_name_unique）上抛 ConflictException——本导入映射剔除了 id，
   * 不存在 id 冲突面，故捕获 ConflictException 即可断定为重名，按
   * importNameCandidate 追加 ` (imported)` / ` (imported) N` 后缀重试
   * （预检查+重试双保险：预检查不做，重试天然覆盖并发窗口；上限
   * TASK_IMPORT_MAX_NAME_CONFLICTS 次后放弃 409）。
   *
   * secrets 红线对称语义：导入物携带的 secrets 键被映射整体忽略（绝不落库），
   * 导入任务 secrets 为空；响应 warnings 常驻"需重新配置"提示。
   */
  async importDefinition(
    payload: ImportTaskDto,
    user?: { id: number; role?: UserRole } | null,
  ): Promise<TaskImportResult> {
    const { dto, warnings } = mapExportToCreateDto(payload);
    let name = dto.name;
    for (let attempt = 0; ; attempt++) {
      try {
        const created = await this.create({ ...dto, name }, user);
        return { taskId: created.id, name: created.name, warnings };
      } catch (err) {
        if (
          err instanceof ConflictException &&
          attempt < TASK_IMPORT_MAX_NAME_CONFLICTS
        ) {
          name = importNameCandidate(dto.name, attempt + 1);
          continue;
        }
        throw err;
      }
    }
  }

  private async checkCircularDependency(
    taskId: string,
    dependencies: Record<string, string>,
  ): Promise<void> {
    // FIX-1.1：dependencies 契约 = Record<显示名快照, 上游任务id>——**value
    // 才是依赖任务 id**（消费方：本环检测、checkDependencies、扇出匹配、
    // 前端 dag-layout 全部读 value）。旧契约 {taskId: taskName}（value=名字）
    // 使本方法 findOne({id: 名字}) 永远查不到 → 深层环静默放行；迁移
    // 1790000000048 已翻转存量行，写入面另有 assertDependencyValuesExist
    // 保证 value 是真实任务 id，本检测自那之后才真正生效。
    const visited = new Set<string>();
    const currentPath = new Set<string>();

    const dependencyIds = Object.values(dependencies);

    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new AppError("TASK_CIRCULAR_DEPENDENCY", { taskId });
      }
    }

    await this.detectCycle(taskId, dependencyIds, visited, currentPath);
  }

  /**
   * FIX-1.1（依赖链契约）：dependencies 映射的每个 **value** 必须是真实存在
   * 的任务 id。value 是环检测/依赖满足/扇出匹配的语义位——存进一个名字或
   * 悬垂 id，后果是下游依赖链**静默永不触发**（checkDependencies 判不满足、
   * 扇出匹配不到完成的任务 id），用户无从察觉。写面即 400（列出坏 value），
   * 前端 buildDependenciesPayload 已保证 value=id；本方法覆盖 API/MCP/脚本
   * 等直连调用方。create 与 update（dependencies 为整体替换语义）共用。
   */
  private async assertDependencyValuesExist(
    dependencies: Record<string, string>,
  ): Promise<void> {
    // F-5（服务层纵深防御）：DTO 边界的 IsDependencyValueMapConstraint 已把
    // value 收口为字符串，但本方法还有**编程式直连调用方**（MCP/脚本/自动
    // 注册，不经全局 ValidationPipe）——value=123/true 之类的非字符串进
    // In([...]) 查 uuid 列会触发 PG 42883（function uuid_eq_integer does
    // not exist）裸 500。这里前置 typeof 收口为可读 400 VALIDATION_FAILED
    // （复用通用校验码，不新增目录条目）。
    const nonStringKeys = Object.entries(dependencies)
      .filter(([, v]) => typeof v !== "string")
      .map(([k]) => k);
    if (nonStringKeys.length > 0) {
      throw new AppError("VALIDATION_FAILED", {
        detail: `dependencies 的依赖值必须是任务 id（字符串），以下键的值类型非法：${nonStringKeys.join(", ")}`,
      });
    }
    const values = [...new Set(Object.values(dependencies))];
    if (values.length === 0) return;
    const found = await this.taskRepo.find({
      where: { id: In(values) },
      select: { id: true },
    });
    const foundIds = new Set(found.map((t) => t.id));
    const missing = values.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new AppError("TASK_DEPENDENCY_NOT_FOUND", {
        ids: missing.join(", "),
      });
    }
  }

  /**
   * FIX-1.3: triggerType 与触发配置的**配对校验**（create=请求体终态；
   * update=合并后实体终态，故缺省字段保留旧值后仍能判出不一致）。
   *
   *  - triggerType=cron ⇒ cronExpression 非空（非空值自身的合法性由 DTO
   *    IsCron5Field / 调度注册同源校验把关，这里只拦「缺配置」）；
   *  - triggerType=fixed_rate ⇒ fixedRate ≥ 1。
   *
   * 不校验的后果不是报错而是**静默失效**：调度注册条件不满足即不注册任何
   * 定时器（scheduleOne），任务在 UI 显示「计划中」却永不触发，misfire
   * 补偿也因 lastTriggerTime 恒空而永久失明——这比 400 糟糕得多。
   */
  private assertTriggerConfigConsistent(state: {
    triggerType: TaskTriggerType;
    cronExpression?: string | null;
    fixedRate?: number | null;
  }): void {
    if (state.triggerType === TaskTriggerType.CRON) {
      const expr = (state.cronExpression ?? "").trim();
      if (!expr) {
        throw new AppError("TASK_TRIGGER_CRON_CONFIG_REQUIRED");
      }
    }
    if (state.triggerType === TaskTriggerType.FIXED_RATE) {
      const rate = state.fixedRate;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 1) {
        throw new AppError("TASK_TRIGGER_FIXED_RATE_CONFIG_REQUIRED");
      }
    }
  }

  private async detectCycle(
    taskId: string,
    dependencyIds: string[],
    visited: Set<string>,
    currentPath: Set<string>,
    depth = 0,
  ): Promise<void> {
    // TASK-007: 递归深度上限——防止深层依赖链的串行 N+1 查询 DoS。
    if (depth > MAX_DEPENDENCY_DEPTH) {
      throw new AppError("TASK_DEPENDENCY_TOO_DEEP");
    }

    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new AppError("TASK_CIRCULAR_DEPENDENCY", { taskId });
      }

      if (currentPath.has(depId)) {
        throw new AppError("TASK_CIRCULAR_DEPENDENCY", { taskId });
      }

      if (visited.has(depId)) {
        continue;
      }

      // TASK-007: 已访问节点集合上限——超宽扇出的依赖图同样拒绝，
      // 上限保证单次校验的数据库查询次数有硬性边界。
      if (visited.size > MAX_DEPENDENCY_DEPTH) {
        throw new AppError("TASK_DEPENDENCY_TOO_DEEP");
      }

      visited.add(depId);
      currentPath.add(depId);

      try {
        const depTask = await this.taskRepo.findOne({ where: { id: depId } });
        if (
          depTask &&
          depTask.dependencies &&
          Object.keys(depTask.dependencies).length > 0
        ) {
          // Use Object.values to get the actual dependency task IDs (not the key names)
          const childDependencies = Object.values(depTask.dependencies);
          await this.detectCycle(
            taskId,
            childDependencies,
            visited,
            currentPath,
            depth + 1,
          );
        }
      } finally {
        currentPath.delete(depId);
      }
    }
  }

  /**
   * FEAT-RENAME: 任务改名后，刷新其它任务 dependencies 里指向它的**显示名 key**。
   *
   * ## 为什么需要
   *
   * `dependencies` 的契约是 `Record<显示名快照, 上游任务id>`——**value 才是
   * 依赖任务 id**（环检测 / 依赖满足 / 上游 SUCCESS 扇出全部读 value），key
   * 仅作展示别名，供 DAG 图与排查场景人读。改名后 key 会变成旧名：功能一切
   * 正常（value 没变），但依赖图上显示一个"不存在的任务名"，值班按图排查时
   * 会对不上任何一行任务。
   *
   * ## 语义边界（刻意保守）
   *
   * - 只改 **value === 被改名任务 id** 的条目；不碰其它任何依赖关系。
   * - 只改 **key 恰好等于旧名** 的条目。若某任务当初保存时 key 已经是别的
   *   形态（如同名冲突降级成 id、或用户在旧版本里手写过别名），保持原样——
   *   我们无法区分"这是旧名快照"与"用户有意写的别名"，误改等于破坏展示信息。
   * - 新名与某个**其它** key 撞车时不覆盖（`Record` 一个 key 只能有一个值，
   *   覆盖会让原依赖关系丢失）。此时保留旧 key：展示名过时是外观问题，
   *   丢依赖关系是功能问题。
   * - best-effort：任何异常只记 warn，绝不回滚或影响改名本身——改名已经
   *   落库，此处失败只意味着图上还显示旧名。
   */
  private async renameDependencyAlias(
    taskId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    try {
      // 候选集：dependencies 里 value 含该 id 的任务。jsonb 无索引，用
      // 包含判定在 SQL 侧先粗筛（`@>` 语义），再在内存里精确定位 key，
      // 避免把全表任务拉进内存。
      const dependents = await this.taskRepo
        .createQueryBuilder("task")
        .where("task.status != :deleted", { deleted: TaskStatus.DELETED })
        .andWhere("task.dependencies @> :probe", {
          probe: JSON.stringify({ [oldName]: taskId }),
        })
        .getMany();

      let touched = 0;
      for (const dependent of dependents) {
        const deps = dependent.dependencies;
        if (!deps || typeof deps !== "object") continue;
        // 精确定位：key === oldName 且 value === taskId
        if (deps[oldName] !== taskId) continue;
        // 新名已被另一个 key 占用 → 保留旧 key，不丢依赖关系
        if (newName !== oldName && deps[newName] !== undefined) continue;

        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(deps)) {
          next[key === oldName && value === taskId ? newName : key] = value;
        }
        // 只写 dependencies 一列——刻意**不**用 `taskRepo.save(entity)`。
        // save() 是整行 UPDATE，而这里的实体来自 QueryBuilder 取数，不含
        // `select: false` 的 webhookSecret 列：整行回写会把它清成 NULL
        // （本仓已有同型生产故障先例，见 update() 的 R-01 注释）。
        // 列级 update 既规避该风险，也不会无谓触碰 updatedAt 之外的列。
        // adr-026-exempt: 只改 dependencies 一列（依赖别名重写），与状态机/生命周期无关；
        // 值来自本次遍历读到的 deps 快照，并发改名属罕见且非破坏性（最坏是多写一次同一别名）。
        await this.taskRepo.update(
          { id: dependent.id },
          { dependencies: next },
        );
        touched += 1;
      }
      if (touched > 0) {
        this.logger.log(
          `FEAT-RENAME: refreshed dependency alias "${oldName}" -> "${newName}" on ${touched} dependent task(s)`,
        );
      }
    } catch (err) {
      // best-effort：改名本身已落库，此处失败只影响 DAG 上的展示名
      this.logger.warn(
        `FEAT-RENAME: failed to refresh dependency alias "${oldName}" -> "${newName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async findAll(p: ListTasksQueryDto) {
    // F-10（DEEP_REVIEW 0ef3bbe）: 轻量投影——?fields=id,name 时只 select
    // 白名单列，跳过 params/secrets/glueSource 等重量列。非法字段 400。
    // （前置解析与 lastStatus 分支共用：两条路径的投影/排序语义必须一致。）
    let select: Record<string, true> | undefined;
    if (p.fields) {
      const requested = p.fields
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      const whitelist = new Set<string>(TASK_PROJECTION_WHITELIST);
      const illegal = requested.filter((f) => !whitelist.has(f));
      if (illegal.length) {
        throw new AppError("TASK_PROJECTION_FIELD_INVALID", {
          fields: illegal.join(", "),
          allowed: TASK_PROJECTION_WHITELIST.join(", "),
        });
      }
      select = Object.fromEntries(requested.map((f) => [f, true])) as Record<
        string,
        true
      >;
    }

    // F-03（本轮审计）: 排序——缺省 createdAt DESC（旧行为逐字节不变）；显式
    // sortBy 走白名单校验（非法字段 400，对齐 fields 投影的既有错误风格）。
    // sortOrder 由 DTO @IsIn(["asc","desc"]) 把关，此处兜底归一为 ASC/DESC。
    let order: Record<string, "ASC" | "DESC"> = { createdAt: "DESC" };
    if (p.sortBy) {
      const sortKey = p.sortBy.trim() as TaskSortKey;
      if (!TASK_SORT_WHITELIST.includes(sortKey as never)) {
        throw new AppError("TASK_SORT_FIELD_INVALID", {
          sortBy: p.sortBy,
          allowed: TASK_SORT_WHITELIST.join(", "),
        });
      }
      order = {
        [sortKey]:
          (p.sortOrder ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC",
      };
    }

    // §2.1（本轮推广）: 游标分页分支——必须在**排序解析之后、过滤装配之前**接入，
    // 因为"游标能不能用"取决于 this.sortKey 的解析结果（见 assertCursorCompatible）。
    // 不带 cursor 时下面一行都不执行，旧路径逐字节不变。
    if (p.cursor !== undefined && p.cursor !== null) {
      this.assertCursorCompatibleWithQuery(p);
      return this.findAllByKeyset(p, select);
    }

    // P2-18: lastStatus（最近一次执行状态）——执行维度的派生过滤，Task 实体
    // 无冗余列（刻意不改 schema），走 QueryBuilder 关联子查询分支；不带
    // lastStatus 时保持 findAndCount 既有路径逐字节不变。
    if (p.lastStatus) {
      // order 恒为单键（缺省 createdAt 或校验后的 sortBy）
      const [[sortKey, dir]] = Object.entries(order) as Array<
        [string, "ASC" | "DESC"]
      >;
      return this.findAllByLastStatus(p, select, sortKey, dir);
    }

    // 过滤条件装配（抽成私有方法，keyset 分支复用同一份，杜绝两套过滤漂移）
    const where = this.buildTaskListWhere(p);

    const [list, total] = await this.taskRepo.findAndCount({
      where,
      select,
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      order,
    });
    this.maskListSecrets(list, select);
    return paginate(list, total, p.page, p.pageSize);
  }

  /**
   * `findAll` 的过滤条件装配（**唯一**真值源，OFFSET / lastStatus / keyset 三条
   * 路径共用）。
   *
   * 提取动机：§2.1 推广引入第三条分支时，若把这段复制过去，任何一处过滤语义
   * 变更（例如新加一个 `triggerType` 过滤）都必须记得改三遍——漏一处就是"某个
   * 端点悄悄不过滤"，而这类缺陷在 mock 掉 API 层的单测里全是绿的。故只留一份。
   *
   * 语义（与提取前逐字节一致）：
   *   · 基线 `status != DELETED`；显式 `p.status` 精确等值**替换**基线；
   *   · `q`（name OR description）走**数组 where**（TypeORM 数组 = 元素间 OR、
   *     元素内 AND）；无 q 时保持单对象 where，既有路径逐字节不变。
   *     NETOPT-3⑤：ILIKE 的 `_`/`%` 一律转义按字面量匹配。
   *   · `name` + `q` 同时给出取**交集**（DTO 明文契约）：q 的 name 分支用
   *     `And()` 并列而非展开覆盖（展开会把 p.name 静默丢弃、结果集变宽）。
   *   · AUTH-01：`projectId="default"` → 未分配行与默认项目行一起命中。
   */
  private buildTaskListWhere(
    p: ListTasksQueryDto,
  ): Record<string, unknown> | Record<string, unknown>[] {
    const base: Record<string, unknown> = {
      status: Not(TaskStatus.DELETED),
    };
    if (p.status) base.status = p.status as TaskStatus;
    if (p.name) base.name = ILike(`%${escapeLikePattern(p.name)}%`);
    const nameFilter = base.name as never;
    if (p.runtime) base.runtime = p.runtime;
    if (p.applicationId) base.applicationId = p.applicationId;
    if (p.projectId) {
      if (p.projectId === "default") {
        base.projectId = Or(IsNull(), In([DEFAULT_PROJECT_ID]));
      } else {
        base.projectId = p.projectId;
      }
    }

    // 关键字检索：name OR description。两个数组元素各自带上 base 的全部
    // AND 条件（TypeORM 的数组语义是元素间 OR，元素内 AND）——否则
    // runtime/projectId 等过滤会被 OR 短路掉。
    if (p.q) {
      const like = `%${escapeLikePattern(p.q)}%`;
      return [
        // name 分支：base 已有 name 过滤时并列（And）而非覆盖。
        {
          ...base,
          name:
            nameFilter !== undefined
              ? And(nameFilter, ILike(like) as never)
              : ILike(like),
        },
        // description 可空：NULL ILIKE x 结果为 NULL（非 true），自然不命中，
        // 无需 COALESCE。base.name（若存在）仍在此分支生效（元素内 AND）。
        { ...base, description: ILike(like) },
      ];
    }
    return base;
  }

  /**
   * §2.1（推广到 GET /tasks）：**游标与本次查询是否可组合**的唯一判定点。
   *
   * 只做"能不能用"的判定，不碰游标内容——格式合法性由 `decodeKeysetCursor`
   * 负责（纯函数，见 common/utils/keyset-cursor.util.ts）。两个组合一律 400：
   *
   * ## ① `cursor` + 显式 `sortBy`（哪怕写的正是 `createdAt`）
   *
   * keyset 游标编码的是**某一组排序键的原值**。本端点的 `sortBy` 白名单有 14 个
   * 键、且方向可正可反，而游标只对 `(createdAt DESC, id DESC)` 这一套序有意义。
   * 放开自由组合的结果不是报错，而是**语义错乱**：查询按 `priority` 序返回，游标
   * 里的 `createdAt` 在该序里毫无位置 → "继续"的起点无意义 → 漏行/重行，且每页
   * 都是 200。故宁可显式拒绝。
   *
   * 为什么连 `sortBy=createdAt` 也拒：调用方传它就说明它认为"可以自定义排序 +
   * 游标"，这个心智模型本身就是错的；而放行它还要额外确认 `sortOrder` 也是
   * `desc`（`asc` 时游标方向相反，必然错乱）。与其做一串"恰好正确才放行"的
   * 条件判断，不如让契约只有一种正确姿势：**带 cursor 就不许带 sortBy**。
   *
   * ## ② `cursor` + `lastStatus`
   *
   * `lastStatus` 走独立的 QueryBuilder 分支（EXISTS 关联子查询，见
   * findAllByLastStatus）。技术上并非不可支持——外层 task 的过滤与排序和 keyset
   * 完全正交，把元组谓词加到同一 qb 上即可。**但本轮不做**，理由是范围与风险：
   * 那条分支的 where 装配是手写的 qb 链（与 findAndCount 的 where 对象是两套
   * 表达），要复核它 6 个过滤项与 keyset 谓词的 AND 优先级、投影形态、count 语义
   * （getManyAndCount 会剥掉 take 但保留 where），属于"再写一条新查询路径"。
   * 在无法保证同等的漏/重验证覆盖之前，**拒绝比静默错乱好**——这与本模块头注
   * "非法一律 400，绝不静默降级"是同一取舍。
   *
   * ⚠️ 拒绝这两组合是**加性**的：不带 cursor 时它们的行为一个字节都没变
   * （`sortBy` / `lastStatus` 单独使用照常工作）。
   */
  private assertCursorCompatibleWithQuery(p: ListTasksQueryDto): void {
    if (p.sortBy !== undefined && p.sortBy !== null) {
      throw new AppError("VALIDATION_FAILED", {
        detail:
          "cursor 不能与 sortBy 同时使用（分页游标绑定固定的排序键 createdAt DESC, id DESC；自定义排序请改用 page/pageSize 的 OFFSET 分页）",
      });
    }
    if (p.lastStatus !== undefined && p.lastStatus !== null) {
      throw new AppError("VALIDATION_FAILED", {
        detail:
          "cursor 不能与 lastStatus 同时使用（按最近一次执行状态过滤走独立的子查询分支，暂不支持游标分页；请改用 page/pageSize 的 OFFSET 分页）",
      });
    }
  }

  /**
   * §2.1（推广到 GET /tasks）keyset 分支：`(createdAt, id) < (cursorAt, cursorId)`
   * 的元组游标翻页。
   *
   * ## 与 executions 分支（getExecutionsByKeyset）的关系
   *
   * 形态与论证**照抄**那边，两处差异都是本端点（任务列表）特有的：
   *   · 过滤条件来自 `buildTaskListWhere`（status/name/q/runtime/applicationId/
   *     projectId），不是 executions 的 `{taskId, status}`；
   *   · 排序**只有一种**：`(createdAt DESC, id DESC)`——`sortBy` 已被
   *     `assertCursorCompatibleWithQuery` 拒掉，故这里的排序键与游标元组**必然
   *     同源**（这正是 keyset 正确性的前提）。
   *
   * ## 为什么 SQL 里用"行值比较 + 子查询取游标行"，而不是毫秒区间
   *
   * 与 `getExecutionsByKeyset` 同一结论（那里有完整实测与证伪记录，此处不重复
   * 长篇论证）。要点：
   *
   *   · `tasks."createdAt"` 是 **naive** `timestamp`，`information_schema` 给出
   *     `datetime_precision = 6`（微秒）；建表迁移 `"createdAt" TIMESTAMP NOT
   *     NULL DEFAULT now()`（未限定精度 = PG 默认 `timestamp(6)`），实体是裸
   *     `@CreateDateColumn()`，全量迁移史里**没有** `ALTER COLUMN ... TYPE` 降精度；
   *   · 写路径不显式赋值 createdAt → 取 `now()`（**事务开始时间**）。同事务批量
   *     插入共享同一微秒值，**跨事务**的同毫秒插入会得到不同微秒值（实测
   *     autoflow_test 里 3/3 行都带非零微秒分量，如 `…:01.357218`）；实体读出后
   *     被截成毫秒（`…:01.357`）。
   *
   * 故 **不能**用下面这种"毫秒半开区间"（704f749e 的原实现，已用真 PG 证伪）：
   *
   *      (createdAt < :at OR (createdAt < :atNext AND id < :cursorId))
   *
   * 分支②隐含"同毫秒内排序完全由 id 决定"，**只在同毫秒行的微秒值恰好相等时
   * 成立**。
   *
   * #### 精确触发条件
   *
   * 同毫秒内存在「**微秒更小**（时间上在游标之后）但 **id 更大**（`> cursorId`）」
   * 的行 → 分支② 的 `id < cursorId` 判它"不满足" → **静默漏行**；反向则会把
   * 时间上在游标**之前**的行误返回（游标行被再次返回 → 原地打转）。
   * ⚠️ **id 与微秒同序时不显形**，故能同时骗过 CI 与人工冒烟。
   *
   * 实测（同毫秒 4 行微秒 .000100/.000200/.000300/.000400，取 .000400 做游标）：
   * 半开区间返回 **4 行**（含游标行本身）❌，行值比较返回 **3 行** ✅。
   *
   * 现在用的写法：
   *
   *      (task.createdAt, task.id) < (
   *        SELECT c."createdAt", c.id FROM tasks c WHERE c.id = :cursorId
   *      )
   *
   * 游标只带 `id`，精确时间由子查询按主键取**库内原值**（含微秒）——DB 值比
   * DB 值，JS 毫秒截断不参与运算，零精度损失；子查询是 PK 单行查找，外层仍走
   * (createdAt, id) 范围扫描。
   *
   * #### 已知且**有意**的语义：游标行被删除 → 该页为空
   *
   * 上面的子查询依赖"游标行仍在库里"。若调用方翻页期间该任务被删除（或硬删），
   * 子查询无行 → 行值比较得 NULL → WHERE 为假 → **本页返回空 items**，
   * `nextCursor: null`。这是刻意选择的**安全提前结束**：
   *   · 不会错行、不会重复（对比：用毫秒近似值硬续会重新引入精度缺陷）；
   *   · 调用方看到"空页 + nextCursor:null"即可判定翻完，语义自洽；
   *   · 任务列表是**软删**（`status=deleted`）为主，硬删极少，实际触发面很小。
   * 有一条用例专门钉住这个行为（tasks-keyset-pagination.spec.ts「游标行被删除」），
   * 将来若有人想改回半开区间，会先撞上它。
   *
   * ### 附带消除的两个坑
   *
   * ① **时区**：早期实现把游标里的 UTC ISO 串**当字符串**绑定。naive
   *    `timestamp` 列上，PG 把带 `Z` 的文本强转时会**丢弃时区**、按会话本地墙钟
   *    解释；`TimeZone=Asia/Shanghai` 下比较值比真实值早 8 小时。实测（同一游标
   *    行，`WHERE "createdAt" < $1` 命中行数，真值 2 行）：字符串参数 → **0 行**
   *    （静默漏行），`Date` 参数 → **2 行**。正偏移时区漏行、负偏移时区重复返回，
   *    `TZ=UTC` 容器里完全隐形 —— 故测试必须用**与时区无关**的断言。
   * ② **精度**：见上，半开区间本身不成立。
   *
   * 现行写法**完全不把时间下传**（由子查询取库内值），两类问题从根上消失；游标
   * 载荷仍保留 ISO 串（毫秒）只为排障可读与 forward-compat，不参与比较运算。
   *
   * ## `total` / `page` 的口径
   *
   * 与 executions 分支一致：`getManyAndCount()` 会剥掉 take/limit 再 COUNT（见
   * typeorm `executeCountQuery`），故 `total` 仍是**同过滤条件下的真实总数**，
   * 不返回 -1/近似值；`page` 回显 1（keyset 与 OFFSET 的"第 N 页"不是同一套
   * 坐标系，回显调用方的 page 会诱导混用）。
   */
  private async findAllByKeyset(
    p: ListTasksQueryDto,
    select: Record<string, true> | undefined,
  ) {
    // 空串 = 调用方显式声明的 keyset 起点（见 getExecutions 的同款约定）；
    // 非空则必须是合法游标，否则 400 —— 绝不降级到 OFFSET 分支。
    const cursor = p.cursor === "" ? null : decodeKeysetCursor(p.cursor);

    const qb = this.taskRepo
      .createQueryBuilder("task")
      // 排序键与游标元组必须同源（createdAt DESC, id DESC）——sortBy 已在
      // assertCursorCompatibleWithQuery 拒掉，故此处恒为该序。
      .orderBy("task.createdAt", "DESC")
      .addOrderBy("task.id", "DESC");

    // 过滤条件：与 OFFSET 分支共用 buildTaskListWhere（单对象或 OR 数组）。
    // qb.where 接受对象**数组**并按 "(a) OR (b)" 加括号拼接（实测 typeorm
    // 1.1.1 getWhereCondition → createWhereConditionExpression），与
    // findAndCount 的数组 where 语义完全一致——故两条路径不会漂移。
    qb.where(this.buildTaskListWhere(p) as never);

    // total 必须在加游标谓词之前取（理由同 getExecutionsByKeyset：typeorm 的
    // COUNT 保留 WHERE，getManyAndCount 会把「共 N 条」算成「剩余 N 条」）。
    // 旧实现在加了游标之后调 getManyAndCount，缺陷被 mock 掩盖——那个 mock
    // 的注释写着「真实的 COUNT 也不含游标」（错的），比生产"更正确"。
    const total = await qb.getCount();

    if (cursor) {
      // 元组游标——**行值比较**，游标那一行的精确 (createdAt, id) 由子查询按
      // 主键从库里取回（含微秒）。**不要**改回"毫秒半开区间"：那版在同毫秒内
      // 微秒不同的行上会漏行/返回游标之前的行，已用真 PG 实测证伪，完整论证见
      // `getExecutionsByKeyset` 头注「已证伪的写法 / 现在的写法」两节。
      //
      // 精度：DB 值比 DB 值，JS Date 的毫秒截断完全不参与运算 → 零精度损失。
      // 索引：子查询是 PK 单行查找，外层仍走 (createdAt, id) 范围扫描。
      // 游标行被并发删除：子查询无行 → 比较得 NULL → WHERE 为假 → 本页为空，
      // 调用方看到 nextCursor: null 即视为翻完（安全地提前结束，不错行不重复）。
      qb.andWhere(
        `(task.createdAt, task.id) < (
           SELECT c."createdAt", c.id FROM tasks c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }

    // F-10 投影（QB 形态：task.<col> 列表）——白名单校验已在 findAll 前置段完成，
    // secrets 永不可能出现在 select 内。不投影时 qb 实体化全部列，与
    // findAndCount 的默认投影一致（含 secrets，随后由 maskListSecrets 脱敏）。
    if (select) {
      qb.select(Object.keys(select).map((col) => `task.${col}`));
    }

    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(p.pageSize + 1);

    const rows = await qb.getMany();

    const hasMore = rows.length > p.pageSize;
    const list = hasMore ? rows.slice(0, p.pageSize) : rows;
    this.maskListSecrets(list, select);
    return paginate(list, total, 1, p.pageSize, {
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      nextCursor: hasMore ? nextKeysetCursor(list) : null,
    });
  }

  /**
   * SEC-02/F-10 列表后处理（findAndCount 与 lastStatus QB 两分支共用同一段）：
   * 默认投影下列表响应 secrets 永久脱敏（叶子值回 ******，密文不外泄）；
   * 投影模式下 secrets 不在 select 内，不进入该循环（maskForResponse 收到
   * undefined 仍是 no-op，不会把 undefined 写成掩码——语义与内联版一致）。
   */
  private maskListSecrets(
    list: Task[],
    select: Record<string, true> | undefined,
  ): void {
    if (select) return;
    list.forEach((t) => {
      t.secrets = this.secretsCrypto.maskForResponse(t.secrets) as
        Record<string, unknown> | null | undefined;
    });
  }

  /**
   * P2-18: findAll 的 lastStatus 分支（QueryBuilder 版）。
   *
   * 语义对齐 findAndCount 路径的全部约定——status!=DELETED 基线（显式 status
   * 时精确等值替换基线，同 `where.status = p.status` 的覆盖语义）、name ILIKE、
   * runtime/applicationId 等值、projectId "default"→(IS NULL OR 默认项目)、
   * F-03 排序白名单与方向归一、F-10 投影、分页 skip/take、SEC-02 脱敏后处理
   * （maskListSecrets 同段共用）——仅多一个 EXISTS 子查询：
   *
   *   该任务最近一次执行（task_executions 中该 taskId 下 createdAt DESC、
   *   tie-break id DESC 的第一条）的 status = :lastStatus。
   *
   * 最近一次还在 pending/running 也如实参与筛选（值班看到的就是当前真实状态）。
   *
   * 索引注记（核实于 task-execution.entity.ts @Index 声明 + 迁移史）：
   * - EXISTS 外层（te）：te."taskId" = task."id" AND te."status" = :lastStatus
   *   命中复合索引 idx_task_executions_task_id_status(taskId, status)；
   * - 最内标量子查询（te2）：按 IDX_task_executions_taskId（taskId 单列索引，
   *   1717473142679 建立）定位该任务的执行行后排序取 TOP1——行数规模 = 单任务
   *   执行数，无 (taskId, createdAt) 复合索引可接受；如生产画像显示单任务执行
   *   数巨大再评估迁移，本轮不加。
   * - 子查询经 TypeORM QB API 生成（本仓无自定义 namingStrategy，物理列名为
   *   驼峰 "taskId"/"createdAt"——切勿手写 snake_case 的 task_id/created_at）。
   */
  private async findAllByLastStatus(
    p: ListTasksQueryDto,
    select: Record<string, true> | undefined,
    sortKey: string,
    dir: "ASC" | "DESC",
  ) {
    const qb = this.taskRepo.createQueryBuilder("task");

    // where 基线与过滤项逐项镜像 findAndCount 路径
    if (p.status) {
      qb.where("task.status = :__status", { __status: p.status });
    } else {
      qb.where("task.status != :__deleted", { __deleted: TaskStatus.DELETED });
    }
    if (p.name) {
      // NETOPT-3⑤ 同源：转义 LIKE 元字符，按字面量匹配（见 findAll 注释）。
      qb.andWhere("task.name ILIKE :__name", {
        __name: `%${escapeLikePattern(p.name)}%`,
      });
    }
    // q（关键字，name OR description）——与 findAndCount 分支逐项镜像。
    // 括号必须显式：不加会把 OR 的右半边提到与前面所有 AND 同级，使
    // runtime/projectId 等过滤被 OR 短路（"搜索能用了，但筛选器失效"）。
    if (p.q) {
      const like = `%${escapeLikePattern(p.q)}%`;
      qb.andWhere("(task.name ILIKE :__q OR task.description ILIKE :__q)", {
        __q: like,
      });
    }
    if (p.runtime) {
      qb.andWhere("task.runtime = :__runtime", { __runtime: p.runtime });
    }
    if (p.applicationId) {
      qb.andWhere("task.applicationId = :__applicationId", {
        __applicationId: p.applicationId,
      });
    }
    // AUTH-01 同款语义："default" → 未分配行与默认项目行一起命中
    if (p.projectId) {
      if (p.projectId === "default") {
        qb.andWhere(
          "(task.projectId IS NULL OR task.projectId = :__defaultPid)",
          { __defaultPid: DEFAULT_PROJECT_ID },
        );
      } else {
        qb.andWhere("task.projectId = :__projectId", {
          __projectId: p.projectId,
        });
      }
    }

    // lastStatus EXISTS：关联子查询（te/te2 引用外层别名 task 的行）
    const latestSub = this.execRepo
      .createQueryBuilder("te2")
      .select("te2.id")
      .where("te2.taskId = task.id")
      .orderBy("te2.createdAt", "DESC")
      .addOrderBy("te2.id", "DESC")
      .limit(1);
    const existsSub = this.execRepo
      .createQueryBuilder("te")
      .select("1")
      .where("te.taskId = task.id")
      .andWhere("te.status = :lastStatus", { lastStatus: p.lastStatus })
      .andWhere(`te.id = (${latestSub.getQuery()})`)
      .setParameters(latestSub.getParameters());
    qb.andWhere(`EXISTS (${existsSub.getQuery()})`, existsSub.getParameters());

    // F-10 投影（QB 形态：task.<col> 列表）——白名单校验已在 findAll 前置段
    // 完成，secrets 永不可能出现在 select 内。
    if (select) {
      qb.select(Object.keys(select).map((col) => `task.${col}`));
    }
    // F-03 排序（sortKey 已过白名单，无注入面）
    qb.orderBy(`task.${sortKey}`, dir);
    qb.skip((p.page - 1) * p.pageSize).take(p.pageSize);

    const [list, total] = await qb.getManyAndCount();
    this.maskListSecrets(list, select);
    return paginate(list, total, p.page, p.pageSize);
  }

  async findOne(id: string) {
    const t = await this.taskRepo.findOne({
      where: { id, status: Not(TaskStatus.DELETED) },
    });
    if (!t) throw new AppError("TASK_NOT_FOUND", { taskId: id });
    // SEC-02: 详情响应同样脱敏；写路径（update）走独立归一化，不受影响
    t.secrets = this.secretsCrypto.maskForResponse(t.secrets) as
      Record<string, unknown> | null | undefined;
    return t;
  }

  /**
   * R-01: 写路径专用取数——返回**未经 maskForResponse 脱敏**的原始实体
   * （secrets 保持库中密文/明文原值），status 过滤与 findOne 完全一致
   * （排除 DELETED）。凡把 findOne() 的脱敏结果直接 save 回库的写路径，
   * 都会把字面量 "******" 整体覆盖到真实 secrets 上（不可逆损毁）——
   * 与 application.service R1 同型修复：写面一律走本方法取数，返回体
   * 再统一经 maskSecretsForResponse 脱敏（读面 findOne 保持脱敏不变）。
   */
  private async findByIdRaw(id: string): Promise<Task> {
    const t = await this.taskRepo.findOne({
      where: { id, status: Not(TaskStatus.DELETED) },
    });
    if (!t) throw new AppError("TASK_NOT_FOUND", { taskId: id });
    return t;
  }

  /**
   * R-01: 写路径返回体统一脱敏——写路径内部消费 RAW 行（findByIdRaw），
   * HTTP 面返回前把 secrets 掩码回 ******，响应契约与既往（消费脱敏副本
   * 时的偶然结果）逐字节一致。
   */
  private maskSecretsForResponse<
    T extends { secrets?: Record<string, unknown> | null | undefined },
  >(t: T): T {
    t.secrets = this.secretsCrypto.maskForResponse(t.secrets) as
      Record<string, unknown> | null | undefined;
    return t;
  }

  async update(
    id: string,
    dto: UpdateTaskDto,
    user?: { id: number; role: UserRole } | null,
  ) {
    // R-01: 写路径走 RAW 取数——findOne 的脱敏副本一旦 save 回库，会把
    // "******" 字面量覆盖到真实 secrets（PATCH 不带 secrets 时必现）。
    const t = await this.findByIdRaw(id);
    // NF-03: 写面属主守卫（ADMIN 全量/属主自己/无主仅 ADMIN）
    await this.assertCanWriteProjectAware(t, user);
    // A4（第三轮审计·中）：乐观锁（可选）——DTO 显式带 expectedUpdatedAt 时
    // 与库内行 updatedAt 比对，不符 → 409，防两个控制台标签页互踩写丢。
    // **缺省（undefined/null）= 跳过检查**：MCP/CLI/SDK 等旧调用方零影响。
    // 比较两侧同一 hydrated Date 的毫秒值（PG 微秒精度在 hydration 时截断，
    // API 序列化与本次比对读的是同一形态，毫秒比较稳定）；不可解析的时间串
    // 按「版本不符」处理（fail-closed，同样 409）。
    // R52（ADR-026 规则 2）：**乐观锁下沉到写谓词**，不再「读后比对」。
    //
    // 旧实现在这里比一次、再在 patchTaskColumns 里无条件写——两次之间的窗口仍是
    // TOCTOU：另一个标签页的写可以**正好**落在这段间隙里，于是「检查通过但覆盖了
    // 别人的更新」，乐观锁形同虚设。现在把期望版本作为**行谓词**下发，判据的解释权
    // 归数据库（与 pause/resume/remove 同一姿态）。
    //
    // 为什么用区间而不是等值：PG 的 timestamptz 存**微秒**，而 hydration 到 JS Date
    // 会截到毫秒；直接等值（哪怕 date_trunc）在不同驱动/时区下都容易出现「差 1μs
    // 永不命中」。区间 [expectedMs, expectedMs + 1ms) 精确对应「同一个毫秒桶」，
    // 既覆盖微秒尾数，也不依赖任何 PG 函数。
    // 不可解析的时间串仍按「版本不符」处理（fail-closed，同旧语义）。
    let expectedVersionMs: number | null = null;
    if (dto.expectedUpdatedAt != null) {
      const ms = new Date(dto.expectedUpdatedAt).getTime();
      if (!Number.isFinite(ms)) throw new AppError("TASK_UPDATE_STALE");
      expectedVersionMs = ms;
      // 读时**预判**只用于「省掉一次注定失败的写」，**不是**判据的最终解释权：
      // 现在是快照与期望值不符就立刻 409（零写入）；而快照看起来一致的情况，
      // 真正的裁决发生在写谓词上（见 patchTaskColumns）——那一段才是关掉 TOCTOU
      // 的地方。两层是分工，不是重复。
      if (expectedVersionMs !== t.updatedAt.getTime()) {
        throw new AppError("TASK_UPDATE_STALE");
      }
    }
    const normalized = this.normalizeTaskDto(dto);
    // F-1（安全红线）：PATCH 请求体不允许重写主键 id。UpdateTaskDto 经
    // PartialType 继承了 CreateTaskDto 的可选 @IsUUID id——不剔除的话，
    // 下方 Object.assign 会把内存实体的主键改掉，taskPatchFromDto 还会把
    // id 写进列级 patch（UPDATE ... SET "id" = ...，改写主键）。
    // 刻意放在 update 路径而非 normalizeTaskDto：create 的 R6 契约（客户端
    // 自带 id + 查重/TASK_ID_EXISTS）合法消费 normalized.id（见 create 内
    // 预检），而 normalizeTaskDto 是 create/update 共享的。形态与同函数既有
    // `delete normalized.secrets` / expectedUpdatedAt 的消费即弃一致。
    delete normalized.id;
    // 同 create：PATCH 显式带 gitRepo 时即校验（缺省 = 保留旧值，不重复校验既有列）
    if (normalized.gitRepo) {
      await assertSafeGitRepoUrl(normalized.gitRepo);
    }
    // FIX-1.1: PATCH 的 dependencies 是整体替换语义（Object.assign 透传）——
    // 本次请求显式带**非空映射**时按 create 同一契约校验 value（必须为存在的
    // 任务 id）；显式 null / 缺省 = 清空/保留，无 value 可校验。
    if (
      normalized.dependencies &&
      typeof normalized.dependencies === "object" &&
      Object.keys(normalized.dependencies).length > 0
    ) {
      await this.assertDependencyValuesExist(normalized.dependencies);
      // F-2: update 路径此前缺环/自依赖检测（checkCircularDependency 只有
      // create 一个调用点）——PATCH 一个自依赖或 A↔B 双环映射会落库成
      // triggerDependentTasks 的永动死链。整体替换语义下显式提供即终态，
      // 按 create 同一契约检测；自身 id 传入使自环也被拒。缺省（不带
      // dependencies）= 保留旧值，存量映射不重复检测。
      await this.checkCircularDependency(id, normalized.dependencies);
    }
    // TASK-PROJ-01: 改变归属项目同样需要授权（缺省 = 保留旧归属，不重复校验）
    if (normalized.projectId !== undefined) {
      await this.assertCanAssignProject(normalized.projectId, user);
    }
    // SEC-02 续（生产故障）：PATCH 语义三态——
    //   · 缺省（undefined）  = 保留旧值（不触碰既有列；R-01: 保留 RAW 原值而非掩码副本）；
    //   · 显式 null          = 清空全部；
    //   · 对象               = **逐键合并**（不是整体替换）。
    // 逐键合并的理由：读路径对所有叶子回 `******`，控制台要显示既有键就必然持有
    // 掩码；整体替换会把掩码当作真实值落库（真实凭据被不可逆覆盖，而 UI 上键还
    // 在——正是本次生产故障的形状）。合并规则与掩码/删除语义见
    // secret-crypto.util.ts 的 mergeSecretsOnUpdate。
    /** R49-A1（S2）：本次请求是否**真的带了** secrets —— 带才写该列。 */
    let secretsPatch: Record<string, unknown> | null | undefined;
    if (normalized.secrets !== undefined) {
      t.secrets =
        normalized.secrets === null
          ? null
          : (this.secretsCrypto.applyPatch(
              t.secrets,
              normalized.secrets as Record<string, unknown>,
            ) as Record<string, unknown>);
      secretsPatch = t.secrets ?? null;
    }
    delete normalized.secrets;
    // A4: expectedUpdatedAt 只服务并发检查（消费即弃，同 timeoutSeconds 模式）
    // ——normalizeTaskDto 是 {...dto} 展开，不删会把检查字段一并 Object.assign
    // 到实体上（非列属性污染实体，R-01 同型问题）。cast：normalizeTaskDto 的
    // 泛型约束是 CreateTaskDto | UpdateTaskDto，仅后者声明了该字段。
    delete (normalized as { expectedUpdatedAt?: unknown }).expectedUpdatedAt;
    // NF-04: 亲和/反亲和为可空列，PATCH null 清除语义直接依赖 Object.assign
    // 的透传（显式 null 覆盖旧数组 → 列落 NULL = 无约束）——normalizeTaskDto
    // 不触碰这两个键；undefined（缺省）不会出现在合并结果上，旧值自然保留。
    // 改名（FEAT-RENAME）：捕获旧名，供 save 后刷新引用方的依赖显示名 key。
    // `Object.assign` 之后 t.name 已是新值，故必须在此**之前**读取。
    const previousName = t.name;
    const updated = Object.assign(t, normalized);
    // R7 (N17): PATCH 合并路径的互斥校验必须看合并后的实体态——请求体只带
    // executorId（已有任务 executeMode=broadcast）或只带 executeMode=broadcast
    // （已有任务已 pin）时，normalizeTaskDto 看不到另一半，会漏判产生
    // "broadcast+已 pin" 非法状态（dispatchBroadcast 不读 executorId，pinning
    // 被静默丢弃）。save 前兜底，消息与 create 路径一致。
    this.assertPinBroadcastExclusive(updated.executorId, updated.executeMode);
    // A-1: PATCH 合并路径的 broadcast × 互斥组互斥校验——看合并后实体态
    //（R7/N17 先例：增量 DTO 看不到另一半）。作用域门（NFR-05 先例）：只在
    // 本次请求确实编辑了 executeMode / applicationId 时判定，存量历史行
    //（写面门上线前创建）连改 timeout 都被拒会把合法 PATCH 一起挡死——
    // 存量行由 dispatchBroadcast 的运行时 warn 兜底可观测。
    if ("executeMode" in dto || "applicationId" in dto) {
      await this.assertBroadcastMutexCompatible(
        updated.executeMode,
        updated.applicationId,
        `task ${id}`,
      );
    }
    // FIX-1.3: PATCH 配对校验看合并后实体态（R7/N17 先例）——增量只带
    // triggerType 或只清 cronExpression 时，增量 DTO 看不到另一半。
    this.assertTriggerConfigConsistent(updated);
    // python_task_multiversion（FR-06/FR-18/FR-19 + CONTRACT §2.1「PATCH 必须按
    // 合并后终态校验」）：同 R7/N17 先例——增量 DTO 看不到旧行的 runtime /
    // applicationId / codeSource，必须看 `updated`（合并态）才能正确判定
    // "非 python runtime 不得声明版本"与三选一互斥。
    this.assertRuntimeVersionValid(updated.runtimeVersion, updated.runtime);
    // NFR-05 作用域门：只有本次请求**确实编辑**了代码来源/runtime 字段时才
    // 判定（CONTRACT §2.1"只约束新建/编辑"）——否则存量 gitRepo+glueSource
    // 并存的历史行连改 timeout 都会被拒。判定对象仍是合并后的终态。
    await this.assertCodeSourceConsistent(updated, {
      touchesCodeSource:
        "gitRepo" in dto ||
        "glueSource" in dto ||
        "applicationId" in dto ||
        "codeSource" in dto,
      touchesRuntime: "runtime" in dto,
      context: `task ${id}`,
    });
    // R49-A1（S2 · ADR-026 规则 4）：**列级条件写**取代整行 `save(updated)`。
    //
    // patch 的键 = normalizeTaskDto 之后 DTO 里真正出现的键（被 normalize 的
    // timeoutSeconds→timeout 映射算"出现的键"；显式 null 照写以保留清除语义）。
    // status **只有 DTO 显式带它时**才进 patch —— 这一点是本次修复的核心：
    // 旧实现把方法早期快照里的 status 一并写回，窗口内并发的 pause/remove 会被
    // 静默盖掉（暂停"自己恢复"、软删行"复活"）。secrets 同理：不带就不写。
    const writePatch = this.taskPatchFromDto(
      normalized as unknown as Record<string, unknown>,
    );
    if (secretsPatch !== undefined) writePatch.secrets = secretsPatch;

    let applied: boolean;
    try {
      applied = await this.patchTaskColumns(id, writePatch, expectedVersionMs);
    } catch (err) {
      // 改名撞唯一索引：tasks.name 上有全局唯一索引 idx_tasks_name_unique
      // （迁移 1790000000050，**含软删除行**）。create 早就有这条分流
      // （见下方 23505 处理），update 此前没有——用户改名撞重名时拿到的是
      // 全局过滤器的笼统 "Resource already exists"，完全不知道撞的是什么，
      // 也不知道"重名可能来自回收站里的任务"。
      if (
        isUniqueViolation(err) &&
        uniqueConstraintName(err) === "idx_tasks_name_unique"
      ) {
        throw new AppError("TASK_NAME_TAKEN", { name: updated.name });
      }
      throw err;
    }
    // 返回体必须是**库里的当前行**，不是本次方法的早期快照：并发写赢家的列要
    // 如实回给调用方（pause/resume 已是同款做法）。
    const saved = await this.taskRepo.findOne({ where: { id } });
    if (!saved) {
      // 规则 3：行谓词不成立的唯一现实来源是窗口内并发 remove 把它软删了。
      // 对外与"先 remove 再 PATCH"的顺序执行同解（404），**绝不**把行写活。
      throw new AppError("TASK_NOT_FOUND", { taskId: id });
    }
    if (!applied) {
      // 写未命中行谓词，但行仍在（否则上面已 404）。两种来源，**语义不同**：
      //   · 带了 expectedUpdatedAt ⇒ 版本已被别人推进 ⇒ 409（乐观锁成立的唯一含义）；
      //   · 没带（旧调用方）⇒ PG 仅在"值完全相同"时报 0，属无变化的成功，按回读返回。
      if (expectedVersionMs !== null) {
        throw new AppError("TASK_UPDATE_STALE");
      }
      this.logger.warn(
        `update ${id}: 列级写未命中行谓词（值未变），按回读结果返回`,
      );
    }
    await this.saveVersion(saved.id, undefined, undefined, saved);
    // 改名后刷新所有引用方的依赖**显示名** key：dependencies 是
    // Record<显示名快照, 上游任务id>，key 仅作展示别名（语义位是 value=id，
    // 环检测/依赖满足/扇出全部读 value）。不刷新的话 DAG 与依赖页会一直显示
    // 旧名——功能正常但"图上有个不存在的任务"，排查时误导人。
    if (previousName !== saved.name) {
      await this.renameDependencyAlias(saved.id, previousName, saved.name);
    }
    // Stop old schedule, then re-register based on new status without waiting for reload
    this.schedulerService.stop(id);
    if (saved.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(saved);
    }
    // R-01: 返回体统一脱敏（内部消费 RAW 行，响应面语义与既往一致）
    return this.maskSecretsForResponse(saved);
  }

  async updateGlue(
    id: string,
    source: string,
    language?: string,
    user?: { id: number; role: UserRole } | null,
  ) {
    // R-01: RAW 取数（findOne 的掩码副本 save 回库 = secrets 不可逆损毁）
    const t = await this.findByIdRaw(id);
    // R-03: 写面归属守卫（镜像 update/remove 口径）——updateGlue 等价于
    // 改写任务执行的代码，此前完全绕过归属守卫。
    await this.assertCanWriteProjectAware(t, user);
    // ---------------------------------------------------------------------
    // P0（UX-AUDIT-2026-09-21 §P0-1）：拒绝空脚本。
    //
    // 此前是 `t.glueSource = source` 直赋，空串照收。写成空串后任务进入一个
    // 自相矛盾的状态：本方法**总是**把 codeSource 声明为 glue、并清空 gitRepo，
    // 于是终态是"代码来源=glue，但没有任何代码"。而执行器侧 `if (glueSource)`
    // 对空串为假 → 整个 glue 分支被跳过 → 任务**静默改用 entrypoint**
    // （main.py / index.js）执行：用户的内联脚本既没跑、也无从找回。
    //
    // 触发路径不止前端一处：控制器端点（task.controller.ts:517）收的是裸内联
    // 类型、没有 class-validator DTO，CLI/MCP/curl 同样能清空。故防线设在
    // service 层（写面唯一入口），且必须在**任何赋值之前**——拒绝时脚本、
    // gitRepo、codeSource 全部保持原样。
    //
    // 纯空白同样拒绝：`"  \n "` 在 `if (glueSource)` 下是真值，会被写成脚本
    // 文件并当成 entrypoint，任务每次都以"空脚本"运行——比空串更隐蔽。
    // 注意：**不**影响"还没有 glue 脚本"的合法状态（那是 glueSource 为
    // null/undefined，从不经过本方法）。
    // ---------------------------------------------------------------------
    if (typeof source !== "string" || source.trim().length === 0) {
      throw new AppError("TASK_GLUE_SOURCE_EMPTY");
    }
    // python_task_multiversion（FR-18 / AC-17b）：glue 写入必须同时**声明**
    // codeSource 并**清空** gitRepo，否则终态变成"gitRepo + glueSource 并存"
    // ——正是三选一互斥要禁止的歧义态（读面按 codeSource 判定会与实际来源
    // 漂移；执行器侧 git clone 分支先跑，glue 代码根本不会生效）。
    // 这里就地收敛而非调用 assertCodeSourceConsistent：本方法的**语义**就是
    // "把代码来源切到 glue"，收敛是确定的，无需把合法请求判成 400。
    //
    // R49-A1（S2 · ADR-026 规则 4）：改成**列级条件写**——只写本方法真正改变的
    // 四列，绝不把方法早期快照里的 status / name / secrets 整行回写（并发 pause
    // 会在一次"只改脚本"的请求里被悄悄恢复）。
    const gluePatch: Record<string, unknown> = {
      glueSource: source,
      codeSource: TaskCodeSource.GLUE,
      gitRepo: null,
    };
    // 缺省 language = 保留旧值（不写该列，而不是写回快照里的旧值）
    if (language) gluePatch.glueLanguage = language;
    const applied = await this.patchTaskColumns(id, gluePatch);
    const saved = await this.taskRepo.findOne({ where: { id } });
    if (!saved) {
      // 同 update：窗口内并发 remove 已把行软删 —— 与顺序执行同解（404）
      throw new AppError("TASK_NOT_FOUND", { taskId: id });
    }
    if (!applied) {
      this.logger.warn(
        `updateGlue ${id}: 列级写未命中行谓词（行已被并发推进或值未变），按回读结果返回`,
      );
    }
    await this.saveVersion(saved.id, undefined, undefined, saved);
    return this.maskSecretsForResponse(saved);
  }

  /**
   * R49-A1（S1 · ADR-026 规则 1/2/3/4）：删除 = **条件状态迁移 + 独立软删**。
   *
   * ## 判定一：哪些状态可删（按现有业务，不收严）
   *
   * `TaskStatus` 只有 active / paused / deleted 三态，**没有"运行中"的任务态**
   * ——执行态在 task_executions 上。故可删起点 = `{active, paused}`：
   *   · 此前 active/paused 都能删，删除也不 kill 在跑的执行（stop 只摘定时器），
   *     本轮维持该业务口径，不凭空收严；
   *   · deleted 不是可删起点：findByIdRaw 已把它当"不存在"（404），且行谓词里
   *     还有 `deletedAt IS NULL`，已软删的行永远不可能被"再删一次"写成别的值。
   *
   * ## 判定二：两步之间第二步失败，要不要补偿
   *
   * 要。失败中间态是 `status='deleted' 且 deletedAt IS NULL`——TypeORM 读面
   * 看得见这一行（deletedAt 为空）、而 status 说它已删除，是全仓最容易被误当成
   * "脏数据已由运维清理"的形态。故第二步失败时**条件回滚** status 到进入本方法
   * 时观察到的起点（`WHERE status='deleted' AND deletedAt IS NULL`）：
   *   · 回滚谓词 from=deleted 保证不会覆盖并发推进（例如另一个 remove 已成功
   *     软删 → deletedAt 非空 → 回滚命中 0，保留赢家结果）；
   *   · 回滚本身失败只记 error（best-effort），行会停在上述中间态，日志里有
   *     明确文案供人工核对——此时不再二次尝试，避免把并发结果踩回去。
   *
   * 顺序为什么是"先状态、后软删"：第一步的谓词要求 `deletedAt IS NULL`，
   * 软删一旦先做，条件状态写就必然命中 0（永远写不进去）。
   */
  async remove(id: string, user?: { id: number; role: UserRole } | null) {
    // R-01: RAW 取数——软删落库同样不得把掩码副本写进 secrets 列
    const t = await this.findByIdRaw(id);
    // NF-03: 写面属主守卫（同 update）
    await this.assertCanWriteProjectAware(t, user);
    // Stop schedule immediately without waiting for reload
    this.schedulerService.stop(id);
    // 第一步：只写 status 一列；判据（可删起点集合 + 软删过滤）在数据库行谓词上。
    const applied = await this.transitionTaskStatus(id, {
      from: [TaskStatus.ACTIVE, TaskStatus.PAUSED],
      to: TaskStatus.DELETED,
    });
    if (!applied) {
      // 规则 3：命中 0 = 并发收敛（行已被别的 remove 软删，或状态已被移出可删
      // 集合）。与"顺序执行时第二次 remove"同解：404，绝不再按旧快照写回。
      this.logger.warn(
        `remove ${id}: status 已被并发迁移或行已软删，跳过写入以保留并发结果`,
      );
      throw new AppError("TASK_NOT_FOUND", { taskId: id });
    }
    // 第二步：DB-001 —— 独立写入 TypeORM 软删除列，此后 Repository
    // find/findOne 自动排除该行；status='deleted' 保留以兼容 raw query 消费方。
    try {
      await this.taskRepo.softDelete(id);
    } catch (err) {
      // 补偿：把 status 条件回滚到进入本方法时观察到的起点（判据见方法注释）
      const rolledBack = await this.transitionTaskStatus(id, {
        from: TaskStatus.DELETED,
        to: t.status,
      });
      if (!rolledBack) {
        this.logger.error(
          `remove ${id}: softDelete 失败后 status 回滚未命中（行已被并发推进），该行可能停在 status=deleted 且 deletedAt 为空，需人工核对`,
        );
      } else {
        this.logger.warn(
          `remove ${id}: softDelete 失败，已把 status 条件回滚为 ${t.status} 以消除中间态`,
        );
      }
      throw err;
    }
    return { deleted: true };
  }

  /**
   * R46-A1（四轴审计 · ADR-026 规则 1/2/4）：`tasks` 行状态迁移的**唯一**写入口。
   *
   * 为什么不能「findByIdRaw 判一下 → 赋 status → save(t)」（本方法取代的旧实现）：
   *
   * 1. **read-then-write 不是条件写**（规则 2 点名的反例）：判与写之间是可乘之机，
   *    两个并发 pause、或 pause 与 remove 并发时，双方都能在"自己看来合法"的
   *    前提下走完，最后谁 save 谁赢；
   * 2. `save(entity)` 的语义是**整行回写**（规则 4）：实体是方法早期读到的快照，
   *    窗口内并发 PATCH 写下的 name / timeout / cronExpression / params / secrets
   *    会被静默盖回旧值；并发的 remove 写入的 status='deleted' 也会被盖回
   *    paused/active —— 即**软删行复活**（TypeORM 的 save 仍会写 status 列）；
   * 3. 条件不命中必须是"跳过写"而不是"照写"（规则 3）。
   *
   * 故这里的证据全部交给数据库行谓词：`WHERE id AND status = :from AND "deletedAt"
   * IS NULL`，且**只写 status 一列**（+ 库时钟 updatedAt）——本次动作真正改变的
   * 列只有它。返回 false = 状态已被别人推进（并发收敛），调用方按各自业务语义
   * 决定对外错误码，但**绝不能**再按旧快照回写。
   *
   * @returns true = 本次动作赢得迁移（affected > 0）
   */
  private async transitionTaskStatus(
    id: string,
    transition: {
      /**
       * 合法起始态。单一状态用等值谓词（最易读）；**集合**（例：remove 的可删
       * 起点 {active, paused}）用 IN —— 两者都把判据放在数据库行谓词上。
       */
      from: TaskStatus | readonly TaskStatus[];
      to: TaskStatus;
    },
  ): Promise<boolean> {
    const rawFrom = transition.from;
    const fromStatuses: TaskStatus[] =
      typeof rawFrom === "string" ? [rawFrom] : [...rawFrom];
    const qb = this.taskRepo
      .createQueryBuilder()
      .update(Task)
      .set({
        status: transition.to,
        // 规则 4：时间戳用**库时钟**。QueryBuilder 的 UPDATE 不像 save() 那样
        // 自动刷新 @UpdateDateColumn，漏了它会让 updatedAt 停在旧值——而
        // PATCH 的乐观锁（expectedUpdatedAt）正是拿它比对的。
        updatedAt: () => "CURRENT_TIMESTAMP",
      })
      .where('"id" = :id', { id });
    if (fromStatuses.length === 1) {
      qb.andWhere('"status" = :from', { from: fromStatuses[0] });
    } else {
      qb.andWhere('"status" IN (:...fromStatuses)', { fromStatuses });
    }
    const result = await qb.andWhere('"deletedAt" IS NULL').execute();
    return (result?.affected ?? 0) > 0;
  }

  /**
   * R49-A1（S2 · ADR-026 规则 1/2/4）：**列级条件写** —— 只写 patch 里给出的
   * 列，且行谓词恒带 `deletedAt IS NULL`。
   *
   * 为什么不是 `repo.save(entity)`：save 的语义是**整行回写**（规则 4），entity
   * 是方法早期读到的快照。窗口内并发 pause / remove / 另一个 PATCH 写下的
   * status / name / timeout 会被静默盖回旧值（含"已软删行复活"）——PATCH 与
   * updateGlue 真正改变的列只有有限几列，没有任何理由写全行。
   *
   * 为什么显式写 updatedAt：QueryBuilder 的 UPDATE **不会**像 save() 那样自动
   * 刷新 `@UpdateDateColumn`（R46-A1 已踩过）。漏了它，PATCH 的乐观锁
   * （expectedUpdatedAt）会读到恒定的 updatedAt，两个标签页可以无限互踩。
   *
   * @returns true = 行谓词成立且写落库（affected > 0）
   */
  private async patchTaskColumns(
    id: string,
    patch: Record<string, unknown>,
    expectedVersionMs: number | null = null,
  ): Promise<boolean> {
    let qb = this.taskRepo
      .createQueryBuilder()
      .update(Task)
      .set({ ...patch, updatedAt: () => "CURRENT_TIMESTAMP" })
      .where('"id" = :id', { id })
      .andWhere('"deletedAt" IS NULL');
    if (expectedVersionMs !== null) {
      // 乐观锁的行谓词（R52）：锁在「同一个毫秒桶」——见 update() 头注里为什么是区间。
      qb = qb.andWhere('"updatedAt" >= :tsFrom AND "updatedAt" < :tsTo', {
        tsFrom: new Date(expectedVersionMs),
        tsTo: new Date(expectedVersionMs + 1),
      });
    }
    const result = await qb.execute();
    return (result?.affected ?? 0) > 0;
  }

  /**
   * R49-A1（S2）：把 normalizeTaskDto 的结果投影成**列级 patch**。
   *
   * 只取本次请求真的带来的键：`undefined` = 没带（保留旧值，不写，语义同
   * "NOT NULL 列不可置空"）；`null` = 显式清空，照写（可空列的 PATCH 清除
   * 语义）。这里不再"补全"任何键——补全就是把快照写回库。
   */
  private taskPatchFromDto(
    dto: Record<string, unknown>,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      // F-1 防御性兜底：主键 id 永不进列级 patch——本方法的所有调用方里只有
      // update 携带 DTO 原键，上游漏删时这里拦下，避免 UPDATE 改写主键。
      // updateGlue 等手工 patch 不含该键，不受影响。
      if (key === "id") continue;
      patch[key] = value;
    }
    return patch;
  }

  async pause(id: string, user?: { id: number; role: UserRole } | null) {
    // R-01: RAW 取数——响应体要脱敏，而写面不得消费脱敏副本（"******" 落库）。
    const t = await this.findByIdRaw(id);
    // AUTH-02: 执行类写面归属（viewer 只读；其余维持既有行为）
    await this.assertCanOperate(t, user);
    // R46-A1: 这里的前置判定只为「顺序执行时给出稳定错误码」而保留；**判据的
    // 最终解释权在数据库**（transitionTaskStatus 的行谓词），不再靠它决定写。
    if (t.status === TaskStatus.PAUSED) {
      throw new AppError("TASK_ALREADY_PAUSED");
    }
    this.schedulerService.stop(id);
    const applied = await this.transitionTaskStatus(id, {
      from: TaskStatus.ACTIVE,
      to: TaskStatus.PAUSED,
    });
    if (!applied) {
      // 规则 3：命中 0 = 并发收敛（行已被别的动作推进/软删），不是 500，
      // 更不许按旧快照盖回去。对外与「顺序执行时第二次 pause」同解（同码同 400），
      // 使"输了竞态"和"来晚了"对调用方不可区分——这正是幂等该有的样子。
      this.logger.warn(
        `pause ${id}: status 已被并发迁移（不再是 active），跳过写入以保留并发结果`,
      );
      throw new AppError("TASK_ALREADY_PAUSED");
    }
    // 返回读侧视图：重新取数（而非返回方法早期快照），避免把窗口内已被别人
    // 改掉的列当成"本次写的结果"回给调用方。
    const saved = await this.taskRepo.findOne({ where: { id } });
    return this.maskSecretsForResponse(saved ?? t);
  }

  async resume(id: string, user?: { id: number; role: UserRole } | null) {
    // R-01: RAW 取数（同 pause）
    const t = await this.findByIdRaw(id);
    // AUTH-02: 执行类写面归属（viewer 只读；其余维持既有行为）
    await this.assertCanOperate(t, user);
    // R46-A1: 同 pause——前置判定只为稳定错误码，写面的判据是行谓词。
    if (t.status !== TaskStatus.PAUSED) {
      throw new AppError("TASK_NOT_PAUSED");
    }
    const applied = await this.transitionTaskStatus(id, {
      from: TaskStatus.PAUSED,
      to: TaskStatus.ACTIVE,
    });
    if (!applied) {
      this.logger.warn(
        `resume ${id}: status 已被并发迁移（不再是 paused），跳过写入以保留并发结果`,
      );
      throw new AppError("TASK_NOT_PAUSED");
    }
    const saved = await this.taskRepo.findOne({ where: { id } });
    const row = saved ?? t;
    await this.schedulerService.scheduleOne(row);
    return this.maskSecretsForResponse(row);
  }

  async trigger(
    id: string,
    dto: TriggerTaskDto,
    user?: { id: number; role: UserRole } | null,
    // R-28（DEEP_REVIEW 0ef3bbe）: triggerType 覆盖——依赖触发链路（
    // triggerDependentTasks）此前经 this.trigger(id, {}) 把 execution.triggerType
    // 错记为 "manual"。默认仍 "manual"（手动/控制器/API-Key 路径不变），
    // 依赖触发方传入 "dependency"。
    triggerTypeOverride?: string,
  ) {
    // F-10（语义钉死，2026-10-25 审计）：trigger 刻意**只排除 DELETED**——
    // findOne 的行谓词是 Not(DELETED)，PAUSED 任务手动/API/依赖触发照常
    // **成功**。这是与维护窗口同一款设计哲学（见 scheduler.enqueue 头注：
    // 「手动/API 触发不受窗口约束——发布窗口内人工补跑是预期操作」）：
    // 暂停只停**调度**（schedulerService.stop 移除定时器），不拦人工显式
    // 触发。若将来要改成「PAUSED 拒绝手动触发」，必须显式产品决策——
    // 回归 spec（task.service.spec「trigger PAUSED 任务手动触发成功」）
    // 会转红，防止无意识收紧。
    const task = await this.findOne(id);
    // AUTH-02: 执行类写面归属（viewer 只读；其余维持既有行为）
    await this.assertCanOperate(task, user);
    // 技术债 A 组（2026-10-01）·按原版本重放：dto.version 指定以版本历史的
    // v<N> 快照派发本次执行（钉定）。校验（存在且属于该任务）在此完成，
    // 不存在 → 404；不传 version 时 pinnedVersion 为 null，后续路径零变化。
    const pinnedVersion =
      dto?.version != null
        ? await this.resolvePinnedVersionForTrigger(task, dto.version)
        : null;
    // N-14：blockStrategy 闸门（与调度路径同规则，task/block-strategy-gate.ts）。
    // 比较维度=「任务+参数」：仅同参在跑/排队才按策略生效，异参放行并发——
    // 参数化任务（如发货程序按订单传参）的合法并发不受影响。在创建执行行
    // 之前施加：discard 命中不落行（409）；cover_early 命中先取消同参执行
    // （含 RUNNING 的 kill 下发与槽位冲销）再落新行。互斥组正交不受影响。
    const effectiveParams = dto.params ?? task.params;
    // B-5（调度域审计）：闸门 TOCTOU 收口——检查+落行套 per-(任务+参数)
    // 短 Redis 锁（语义与取舍见 acquireTriggerGateLockOrThrow 注释）。
    const gateLock = await this.acquireTriggerGateLockOrThrow(
      task,
      effectiveParams,
    );
    let exec: TaskExecution;
    let endSpan: ((error?: string) => void) | undefined;
    try {
      const gateOutcome = await applyBlockStrategyGate(
        task,
        effectiveParams,
        this.execRepo,
        {
          warn: (message) => this.logger.warn(message),
          releaseSlot: (address) =>
            releaseExecutorSlotByAddress(this.dataSource, address),
          notifyKill: (executionId, address, executorId) =>
            // P2-3: 透传被覆盖行的行身份（pull 同址多行时按行寻路 kill）。
            this.executorService.notifyExecutorKill(
              executionId,
              address,
              executorId,
            ),
        },
      );
      if (gateOutcome === "skip") {
        throw new AppError("TASK_BLOCK_STRATEGY_REJECTED", {
          name: task.name,
        });
      }
      // OBS-01: 追踪开启时生成 trace 根，traceId 落库（null=追踪未开启）。
      const traceparent = this.tracing?.startTrace() ?? null;
      const traceId = this.tracing?.extractContext(traceparent) ?? null;
      endSpan = this.tracing?.startSpan(traceId, "task.trigger", {
        taskId: task.id,
        taskName: task.name,
      });
      exec = await this.dataSource.transaction(async (manager) => {
        return manager.save(
          manager.create(TaskExecution, {
            taskId: task.id,
            taskName: task.name,
            status: ExecutionStatus.PENDING,
            // N-14：与闸门比较同源——行 params 即生效参数
            params: effectiveParams,
            // R-28: 默认 manual；依赖触发方传入 "dependency"。
            triggerType: triggerTypeOverride ?? "manual",
            // 技术债 A 组：钉定重放时执行记录记**钉定版本号**（如 "v3"），
            // 而非任务 currentVersion——详情页/版本对比据此可读出「这次跑的
            // 是哪个版本的快照」。不钉定时维持原值。
            taskVersion: pinnedVersion
              ? pinnedVersion.version
              : task.currentVersion,
            // MUTEX-01：互斥组快照（task→application；未挂组为 null）。
            mutexGroupId: await resolveTaskMutexGroupId(manager, task),
            traceId: this.tracing?.isValidTraceId(traceId) ? traceId : null,
          }),
        );
      });
    } finally {
      // B-5: 持锁窗口覆盖「闸门检查 + 执行行落库」，落行完成即释放——后续
      // queue.add 是幂等性无关的旁路（行已存在，闸门对 PENDING 本就不计）。
      // 释放失败仅吞掉：锁有 TTL 兜底（秒级），不阻断触发主链。
      if (gateLock) {
        try {
          await gateLock.release();
        } catch {
          /* TTL 兜底，忽略 */
        }
      }
    }
    try {
      await this.taskQueue.add(
        "execute",
        // 技术债 A 组：钉定重放把版本行 id 随 job 数据透传 processor——
        // processor 据此取快照覆盖**派发载荷**（applyPinnedVersionSnapshot），
        // 任务当前配置零影响。只随 job 走、不落库；BullMQ 重试复用同一
        // job 数据故钉定不丢；互斥唤醒/stale 恢复的重新入队走既有「当前
        // 配置派发」语义（与所有执行行的恢复路径一致，见 processor 注释）。
        // 不钉定时与旧载荷逐字节一致（既有用例断言精确匹配）。
        pinnedVersion
          ? { executionId: exec.id, pinnedVersionId: pinnedVersion.id }
          : { executionId: exec.id },
        {
          // Bull requires attempts >= 1; guard against maxRetry=0
          attempts: Math.max(1, task.maxRetry ?? 1),
          // CORE-02: delay 预乘指数基座并加 ±20% 抖动（首次尝试 attempt=1）。
          // 返回 0（retryDelay<=0）保持既有 backoff: undefined 不延迟语义。
          backoff:
            task.retryDelay > 0
              ? {
                  type: "exponential",
                  delay: jitteredRetryDelayMs(task.retryDelay, 1),
                }
              : undefined,
          // N2: unify with scheduler.enqueue — always pass a normalized numeric
          // priority (DB stores the PG string enum; a raw label must never
          // reach BullMQ, which rejects non-integer priorities).
          // A4: 再经方向换算——BullMQ 数值越小越先出队，DB 4=紧急 → 1。
          priority: toBullPriority(normalizeTaskPriority(task.priority)),
        },
      );
      endSpan?.();
    } catch (err: unknown) {
      // P1: the PENDING row is already committed — without compensation it
      // would hang forever when Redis/the queue is down.
      const message = err instanceof Error ? err.message : String(err);
      endSpan?.(message);
      // A1: 入队失败补偿走统一终态门（W-7 窗口内无并发回调，但保持一致性）
      await transitionOneToTerminal(this.execRepo, {
        id: exec.id,
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage: `任务入队失败：${message}`,
          failureReason: ExecutionFailureReason.UNKNOWN,
        },
        from: [ExecutionStatus.PENDING],
      });
      // FIX-4.2: 补偿终态已落库，同样唤醒 webhook wait 等待方。
      this.publishExecutionWake(exec.id);
      this.logger.error(`Failed to enqueue execution ${exec.id}: ${message}`);
      throw new AppError("TASK_ENQUEUE_FAILED", { message });
    }
    endSpan?.();
    return exec;
  }

  /**
   * B-5（调度域审计）：blockStrategy 闸门的 TOCTOU 收口——触发路径套
   * per-(taskId + canonicalParams) 短 Redis 锁。
   *
   * 背景：闸门是 find（在跑/排队执行）→ 判定 → 落行的三步**非原子**操作。
   * 手动/API/webhook 并发同参触发时，双方都可能读到「无在跑」而双双放行：
   * discard 语义下落两行重复执行；cover_early 语义下两方各自「取消同参在跑」
   * ——先落终态者赢，后到者 cover 落空仍照样落新行 → 同参双重派发。调度
   * 路径无此洞：enqueue 的 task:trigger 去重锁（不释放、TTL=去重窗）天然
   * 把同任务触发串行化。
   *
   * 语义取舍：
   * - 持锁窗口覆盖「闸门检查 + 执行行落库」（trigger 主链内 try/finally），
   *   锁被占用 = 同参并发触发在途 → 与 discard 命中同语义拒绝（手动/API 面
   *   409；webhook / 依赖触发同走本方法受益）。已持锁方正常放行。
   * - Redis 故障 fail-open（与仓库既有纪律一致）：acquireLock 抛错仅 warn
   *   并退回既有非原子行为——绝不因 Redis 停摆阻断触发。
   * - SERIAL 不取锁：闸门对 SERIAL 本就直通（触发层不拦，串行由互斥组
   *   执行层承担），无需串行化检查窗口。
   * - redisLockService 为 null（@Optional 装配缺席的存量单测/降级装配）
   *   同样 fail-open。
   *
   * @returns 取到的锁（调用方负责在落行后 release）；null = 无需锁 / fail-open
   * @throws ConflictException 同参触发锁被占用（并发去重语义）
   */
  private async acquireTriggerGateLockOrThrow(
    task: Pick<Task, "id" | "name" | "blockStrategy">,
    effectiveParams: Record<string, unknown> | null | undefined,
  ): Promise<Lock | null> {
    if (task.blockStrategy === BlockStrategy.SERIAL || !this.redisLockService) {
      return null;
    }
    // 锁 key 含参数规范化摘要（与闸门同参判定同源），异参触发互不阻塞。
    const key = `task:trigger-gate:${task.id}:${createHash("sha256")
      .update(canonicalizeParams(effectiveParams))
      .digest("hex")
      .slice(0, 24)}`;
    let lock: Lock | null = null;
    try {
      lock = await this.redisLockService.acquireLock(
        key,
        TRIGGER_GATE_LOCK_TTL_MS,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Trigger gate lock unavailable for task "${task.name}" (${err instanceof Error ? err.message : String(err)}); proceeding without trigger serialization (fail-open)`,
      );
      return null;
    }
    if (!lock) {
      throw new AppError("TASK_TRIGGER_CONCURRENT", {
        name: task.name,
      });
    }
    return lock;
  }

  /**
   * 技术债 A 组（2026-10-01）·按原版本重放：定位 (taskId, v<N>) 的版本
   * 快照行。快照表按 taskId 过滤——「存在」与「属于该任务」一并校验，
   * 不满足即 404（含数字越界/版本从未生成两种情形，不区分报错避免泄露
   * 版本空间信息）。版本行不可删除（VER-DIFF-02 已移除删除面），job 数据
   * 里只带版本行 id 是稳定引用。
   */
  private async resolvePinnedVersionForTrigger(
    task: Task,
    versionNumber: number,
  ): Promise<TaskVersion> {
    const row = await this.versionRepo.findOne({
      where: { taskId: task.id, version: `v${versionNumber}` },
    });
    if (!row) {
      throw new AppError("TASK_VERSION_NOT_FOUND", {
        taskId: task.id,
        version: versionNumber,
      });
    }
    return row;
  }

  /**
   * GET /tasks/:id/executions 的读实现。
   *
   * PLAN-BACKEND-ARCHITECTURE §2.1「游标分页」——**加性过渡**，两条路径严格分离：
   *
   *   · `p.cursor` **未传** → 走下方**原有**的 `findAndCount` + skip/take（OFFSET
   *     分支）。这一支的代码路径、SQL 形态、返回对象全部与引入游标之前逐字节
   *     相同（`paginate` 不传 options，信封里连 `nextCursor` 键都不出现）。
   *   · `p.cursor` **已传** → 走 `getExecutionsByKeyset`（见其注释）。
   *
   * 为什么用"参数是否存在"而不是"page 是否 > 1"来分流：游标语义与页码无关，
   * 调用方可能只想给一个全新入口（永远不传 page）。两种模式混用会得到彼此矛盾
   * 的页（keyset 的"第 2 页"不等于 OFFSET 的第 2 页），故只要带了 cursor 就
   * **忽略 page**（响应里的 page 回显 1，见 keyset 分支注释）。
   *
   * ## 空的 `cursor=` 是**显式的「从最新一行开始 keyset」标记**
   *
   * 这是本方案唯一的"引导入口"，不解决它调用方永远进不了 keyset 模式：OFFSET
   * 分支出于逐字节不变的硬要求**不返回** `nextCursor`，所以客户端拿不到第一个
   * 游标。故约定 `?cursor=`（值为空串）表示"以 keyset 模式从第一页开始"——服务端
   * 照常下发 `nextCursor`，客户端此后只需原样回传即可一直翻到底。
   *
   * ⚠️ 这与"坏游标静默退回第一页"**必须区分开**：那是**未声明的**降级（客户端
   * 以为自己在中途，服务端悄悄给了开头 → 死循环）；这里是调用方**显式声明**的
   * 起点。故 `""` 在进入 keyset 分支后直接表示"无下界"，而任何**非空**的畸形
   * 游标一律 400（`decodeExecutionCursor` 不放松，它仍然拒绝空串——起点语义只
   * 存在于服务层的这个入口判断里）。
   */
  async getExecutions(
    taskId: string,
    p: PaginationDto & { status?: string; cursor?: string },
  ) {
    if (p.cursor !== undefined && p.cursor !== null) {
      return this.getExecutionsByKeyset(taskId, p, p.cursor);
    }

    const where: Record<string, unknown> = { taskId };
    if (p.status) where["status"] = p.status;

    const [list, total] = await this.execRepo.findAndCount({
      where,
      // PERF-03（本轮体验审查）：必须显式排除重型文本列。
      // task_executions.logs 是 text 列，回调 DTO 允许单条 512_000 字符
      // （execution-callback.dto.ts 的 @MaxLength(512_000)）——一页 20 行满载
      // 时仅 logs 就接近 10 MB，全部经 JSON 序列化、网络传输、再被前端丢弃：
      //   · TaskDetailPage 执行历史表只渲染 status/executorAddress/startTime/
      //     duration/errorMessage（第 268-320 行），**从不读 logs**；
      //   · 执行详情页的日志走独立端点 GET .../logs（按行分页）与 SSE 流，
      //     不依赖列表响应里的 logs；
      //   · aiAnalysis（同样 text）只在详情页 / 报告端点展示。
      // 故排除它们对功能零影响，却把该端点的响应体缩小一到两个数量级。
      // 注：TypeORM 1.x 已移除 find 选项 select 的字符串数组形态
      // （0.3.x 时代靠 FindOptionsSelectByString 勉强可用），改用对象形态，
      // 列名仍由元数据运行时派生（见 execution-list-projection.ts）。
      select: executionListSelectMap(this.execRepo),
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      // FIX-5.3: id 决胜键——createdAt 非唯一（同刻批量提交/同任务并发行），
      // 单键排序下 OFFSET 翻页会漏行/重行（与 scheduler stale sweep 翻页同
      // 教训——该处已加决胜键，读端点此前未同步）。
      order: { createdAt: "DESC", id: "DESC" },
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  /**
   * §2.1 keyset 分支：`(createdAt, id) < (cursorCreatedAt, cursorId)` 的元组游标
   * 翻页。
   *
   * ## 游标的非法处理
   *
   * `decodeExecutionCursor` 是**唯一**的合法性判定点（纯函数 + 独立单测），任何
   * 畸形输入都在这里抛 400 `VALIDATION_FAILED`。**绝不**把非法游标当成"没传游标"
   * 降级到 OFFSET 分支——那会让客户端陷入"带着坏游标请求、每次拿回第 1 页、
   * 每次都是 200"的死循环（详见 keyset-cursor.util.ts 头注）。
   *
   * ## 为什么 SQL 里用"行值比较 + 子查询取游标行"，而不是毫秒区间
   *
   * PostgreSQL 支持行值比较 `(a, b) < (:at, :id)`，正是这里要的形状。但**不能**
   * 把 `:at` 绑成"实体读出的毫秒 Date"或游标里的 ISO 串——两版都已被实测证伪：
   *
   *   · `task_executions."createdAt"` 的列类型是 `TIMESTAMP`（无时区，PG 精度
   *     **微秒**，`now()` 生成），而 JS `Date` 只有**毫秒**；
   *   · 执行行写入时**不显式给 createdAt**（executor/scheduler/task 三处
   *     `execRepo.create({...})` 都不带该列），取数据库默认值 `now()` = **事务
   *     开始时间**。同事务批量插入共享同一微秒值，但**跨事务**的同毫秒插入会
   *     得到不同的微秒值（`.000456` 这种），在高频执行面上很常见。
   *
   * ### 已证伪的写法：毫秒半开区间
   *
   *      (createdAt < :at OR (createdAt < :atNext AND id < :cursorId))
   *
   * 分支②隐含"同一毫秒内的行排序完全由 id 决定"，**只在同毫秒行的微秒值恰好
   * 相等时成立**。
   *
   * #### 精确触发条件（本缺陷最有价值的部分）
   *
   * 同毫秒内存在「**微秒更小**（时间上在游标之后）但 **id 更大**（`> cursorId`）」
   * 的行 → 分支② 的 `id < cursorId` 把它判为"不满足" → **静默漏行**。
   * 反向同样成立：微秒更大（时间上在游标之前）但 `id < cursorId` 的行会被误返回
   * （游标行本身被再次返回 → 翻页原地打转）。
   *
   * ⚠️ **id 与微秒同序时不显形**——这正是它能同时通过 CI、既有单测与人工冒烟的
   * 原因：只有当 uuid 的随机字典序与微秒的写入顺序**反着**时才会漏行。
   *
   * #### 实测（真 PG，Asia/Shanghai，同毫秒 4 行）
   *
   *     id…50  .0004  ← 游标行
   *     id…10  .0003
   *     id…40  .0002
   *     id…60  .0001
   *
   *     期望下一页          : 10, 40, 60
   *     半开区间（旧实现）  : 10, 40      ← 漏 id…60（在游标之后，但 60 > 50）
   *     行值比较（现实现）  : 10, 40, 60  ✅
   *
   * 另一组同毫秒 4 行（微秒 .000100/.000200/.000300/.000400，取 .000400 做游标）：
   * 半开区间返回 **4 行**（含游标行本身）❌，行值比较返回 **3 行** ✅。
   *
   * ### 现在的写法（正确）
   *
   *      (e.createdAt, e.id) < (
   *        SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId
   *      )
   *
   * 游标只带 `id`，精确时间由子查询按主键从库里取**原值**（含微秒）——DB 值比
   * DB 值，JS 的毫秒截断完全不参与运算，零精度损失。子查询是主键单行查找，外层
   * 仍走 (createdAt, id) 范围扫描。
   *
   * 游标行被并发删除时：子查询无行 → 行值比较得 NULL → WHERE 为假 → 本页为空，
   * 调用方看到 `nextCursor: null` 即视为翻完。这是**安全地提前结束**（不错行、
   * 不重复），比"用毫秒近似值硬续"安全得多。
   *
   * ### 附带修掉的时区陷阱（保留记录）
   *
   * 早期实现把 `cursor.createdAt`（UTC 形态的 `'…T16:58:01.357Z'`）**当字符串**
   * 绑定。`task_executions."createdAt"` 是 **naive** `timestamp`（无时区）；PG 把
   * 带 `Z` 的文本强转成 naive timestamp 时**丢弃时区**、按**会话本地墙钟**解释，
   * 于是 `TimeZone=Asia/Shanghai` 时比较值比真实值**早 8 小时**。实测（同一游标
   * 行，`WHERE "createdAt" < $1` 命中行数，真值 2 行）：字符串参数 → **0 行**
   * （静默漏行），`Date` 参数 → **2 行**（正确）。正偏移时区漏行、负偏移时区重复
   * 返回，`TZ=UTC` 容器里完全隐形——故测试必须用**与时区无关**的断言。
   *
   * 现行写法里时间完全不下传（由子查询取库内值），这类时区/精度问题被从根上
   * 消除；游标载荷仍保留 ISO 串（毫秒）只为**排障可读**与 forward-compat，
   * 不参与比较运算。
   *
   * ## `total`：仍然给真实总数（不撒谎）
   *
   * keyset 分支复用**同条件**的 `COUNT`。为什么不按"keyset 不需要总数"省掉它：
   * `total` 的类型是 `number` 且四端都在渲染"共 N 条"（分页器、CLI 输出、MCP 工具
   * 载荷）。返回 `-1`/近似值/上一次的值都是**撒谎**——`total` 没有任何字段级的
   * "这是估算"标记，调用方无从分辨。代价是一次 COUNT（`(taskId, ...)` 上有索引，
   * 且与 OFFSET 分支本来就在做的 `findAndCount` 是同一量级），换来的是语义正确。
   * 若将来真需要省这一条，正确做法是新增 `totalExact: false` 之类的显式标记，
   * 而不是悄悄改 `total` 的含义。
   *
   * ## 为什么 `page` 回显 1
   *
   * keyset 与 OFFSET 的"第 N 页"不是同一套坐标系（前者是无状态的"从游标继续"，
   * 后者是"跳过前 N-1 页"）。回显调用方的 `p.page` 会让响应看起来像 OFFSET 的
   * 第 N 页——那正是最容易让调用方把两种模式混用、进而漏页的误解。回显 1
   * （= "本次是从某个位置继续取的第一页"）诚实且不会诱导混用；`page` 的类型与
   * 是否出现都没变（仍是 `number`），只影响 keyset 分支下的取值。
   */
  private async getExecutionsByKeyset(
    taskId: string,
    p: PaginationDto & { status?: string },
    rawCursor: string,
  ) {
    // 空串 = 调用方显式声明的 keyset 起点（见 getExecutions 注释）；非空则必须
    // 是合法游标，否则 400。
    const cursor = rawCursor === "" ? null : decodeExecutionCursor(rawCursor);

    const where: Record<string, unknown> = { taskId };
    if (p.status) where["status"] = p.status;

    const qb = this.execRepo
      .createQueryBuilder("e")
      .select(executionListSelectColumnsAliased(this.execRepo))
      // 排序键与游标元组必须同源（createdAt DESC, id DESC），否则"继续"的
      // 起点与结果集排序不符，翻页会漏/重。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC")
      .where("e.taskId = :taskId", { taskId });

    if (cursor) {
      // 元组游标——**行值比较**，游标那一行的精确值由子查询从库里取回。
      //
      // 为什么不能再用"毫秒半开区间"（704f749e 的原实现，已实测证伪）：
      // 原实现是
      //     (createdAt < :at OR (createdAt < :atNext AND id < :cursorId))
      // 其中 `:at` 来自实体读出的 JS `Date`（**毫秒**，微秒被截断），而列是
      // 微秒精度。分支②隐含假设"同一毫秒内的行排序完全由 id 决定"——**该假设
      // 只在同毫秒行的微秒值恰好相等时成立**。同毫秒但微秒不同时（跨事务写出的
      // 行很常见；`now()` 是事务开始时间，同事务批量插入才会共享微秒）：
      //   · 该行时间上在游标**之后**、却 `id > cursorId` → 被判不满足 → **漏行**；
      //   · 该行时间上在游标**之前**、却 `id < cursorId` → 被判满足 → **返回游标
      //     之前的行**（实测：游标行本身被再次返回，翻页原地打转）。
      //
      // 真 PG 实测（autoflow_test，同毫秒 4 行微秒 .000100/.000200/.000300/.000400，
      // 取 .000400 那行做游标）：
      //   半开区间谓词 → 返回 4 行（含游标行本身） ❌
      //   行值比较     → 返回 3 行，与期望逐项一致 ✅
      //
      // 故改为 `(createdAt, id) < (游标行的精确 (createdAt, id))`，由子查询按主键
      // 取游标行的**库内原值**（含微秒）——DB 值比 DB 值，JS 的毫秒截断完全不
      // 参与运算，没有任何精度损失。子查询是主键单行查找，外层仍是
      // (createdAt, id) 上的范围扫描。
      //
      // 游标行被并发删除时：子查询无行 → 行值比较得 NULL → WHERE 为假 → 本页为
      // 空（此时调用方看到 `nextCursor: null` 即视为翻完）。这是**安全地提前
      // 结束**，不会错行/重复——比"用毫秒近似值继续"要安全得多。
      qb.andWhere(
        `(e.createdAt, e.id) < (
           SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }
    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(p.pageSize + 1);

    if (p.status) qb.andWhere("e.status = :status", { status: p.status });

    const [rows, total] = await Promise.all([
      qb.getMany(),
      this.execRepo.count({ where: where as never }),
    ]);

    const hasMore = rows.length > p.pageSize;
    const list = hasMore ? rows.slice(0, p.pageSize) : rows;
    return paginate(list, total, 1, p.pageSize, {
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      nextCursor: hasMore ? nextExecutionCursor(list) : null,
    });
  }

  async getAllExecutions(
    p: PaginationDto & {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
      cursor?: string;
    },
  ) {
    // §2.1（推广到 GET /tasks/executions/all）: 游标分页分支。
    // 不带 cursor 时下面一行都不执行，旧路径**逐字节不变**（响应里连
    // nextCursor 这个键都不出现，见 paginate 的 options.nextCursor 契约）。
    if (p.cursor !== undefined && p.cursor !== null) {
      return this.getAllExecutionsByKeyset(p, p.cursor);
    }

    // DB-003: 原 getRawAndEntities + getCount 会产生 3 条 SQL（raw 页查询、
    // entities 页查询、count），executions 被全表扫描两次。改为：
    // 1) getManyAndCount：页查询 + count 共 2 条（仅 executions 扫描）；
    // 2) 任务名回填只对缺 taskName 的行做一次 PK IN 批量查询（join 仅在
    //    taskName 过滤时保留用于匹配 t.name）。
    // PERF-03（本轮体验审查）：同 getExecutions——排除 logs/aiAnalysis 两个
    // 重型 text 列（单条上限 512_000 字符）。列表页（ExecutionsPage）只渲染
    // taskName/status/triggerType/executorAddress/startTime/duration/
    // errorMessage，CommandPalette 只取 id/taskName/status，都不读 logs。
    const qb = this.execRepo
      .createQueryBuilder("e")
      .select(executionListSelectColumnsAliased(this.execRepo))
      // FIX-5.3: id 决胜键（同 getExecutions——createdAt 非唯一，OFFSET 翻页
      // 无决胜键会漏行/重行）。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC")
      .skip((p.page - 1) * p.pageSize)
      .take(p.pageSize);

    // 过滤条件：与 keyset 分支**共用同一份**装配（见 applyAllExecutionsFilters）
    this.applyAllExecutionsFilters(qb, p);

    const [list, total] = await qb.getManyAndCount();

    const items = await this.backfillExecutionTaskNames(list);
    return paginate(items, total, p.page, p.pageSize);
  }

  /**
   * 导出执行记录为 CSV——**真正的流式**写入（`GET /tasks/executions/export`）。
   *
   * ## 为什么入口在 service 而不是 controller
   *
   * 导出要做三件互相依赖的事：按固定排序**分页拉取**（不能一次 `find` 全量）、
   * 逐行做 CSV 编码、以及把行写进响应并处理**背压**。前两件与 HTTP 无关，第三件
   * 需要一个"写一段文本"的能力——故这里只依赖一个 `write` 回调，由 controller
   * 把它绑到 `res.write` + `drain`。这样背压逻辑可被单测直接验证（见
   * `__tests__/executions-export.spec.ts` 的 drain 用例），不必起真 HTTP。
   *
   * ## 为什么必须流式（而不是"查全量 → 拼一个大字符串 → res.send"）
   *
   * 表的上限不是理由（有 5 万行硬顶，内存可控），**行宽**才是：单条
   * `errorMessage` 允许 512_000 字符，5 万行理论上是 25 GB；即便实际分布温和，
   * 拼接也意味着"整份 CSV 在内存里同时存在一份字符串 + 一份 Buffer"，
   * 且首字节要等到最后一个数据库页返回才发出（反代 60s 空闲断流先例）。
   * 流式把峰值内存压到"一页行 + 一页文本"，且第一个字节在第一次 DB 往返后
   * 就出去。
   *
   * ## 背压（这是"流式"与"往 res 里循环 write"的分水岭）
   *
   * `res.write()` 返回 false 表示内核发送缓冲已满，继续写会把整份结果堆在
   * Node 的进程内 buffer 里——OOM 的成因不是"结果太大"而是"没人等 drain"。
   * 故每次写完检查返回值，false 时 `await once(drain)`。同时监听 socket 的
   * `close`：客户端中途取消下载时立刻停止拉库，不把剩下的页空跑完。
   *
   * ## 与列表端点的过滤同源
   *
   * 六个过滤器**全部**经 `applyAllExecutionsFilters` 下发——那是
   * `GET /tasks/executions/all` 与 `GET /tasks/:id/executions` 的唯一真值源。
   * 本方法**不复制**任何 where 构造（复制一份是"导出与列表筛选结果不一致"的
   * 唯一成因，且这种不一致不会有任何报错）。
   *
   * ## 排序与列表一致（createdAt DESC, id DESC）
   *
   * 同一份 (createdAt, id) 全序键：导出文件的行序与列表页**逐行对应**，运维
   * 拿 CSV 与页面比对时不会看到"同样的筛选，顺序却不同"。分页走
   * `(createdAt, id)` **行值比较**的 keyset——不用 OFFSET，因为导出要跨几百页，
   * 深 OFFSET 随页数线性变慢，且分页期间的并发写入会让 OFFSET 漏行/重行
   * （导出比列表更需要"不漏不重"：它是要被归档的一次快照）。行值比较的
   * 微秒精度论证见 `getExecutionsByKeyset` 头注。
   */
  async streamExecutionsCsv(
    filters: {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
    write: (chunk: string) => Promise<void>,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ rows: number; truncated: boolean }> {
    const cap = EXECUTION_EXPORT_ROW_CAP;
    const requested = options.limit;
    // 只允许调小（契约见 ExportExecutionsQueryDto.limit）：>硬顶一律归一，
    // 不报错——事故中回 400 比给一份"截断但有痕"的文件糟得多。
    const limit =
      typeof requested === "number" &&
      Number.isFinite(requested) &&
      requested > 0
        ? Math.min(Math.floor(requested), cap)
        : cap;

    // 表头自带换行：数据页每块都以 `\n` 结尾，表头也必须如此，否则第一条
    // 数据行会与表头拼成同一行（一个只在"恰好 0 行"时才不出现的静默错位）。
    await write(`${executionCsvHeaderRow()}\n`);

    let written = 0;
    // 上一页最后一行的 (createdAt, id)：下一页的键集下界（无 OFFSET）。
    let lastCursor: { createdAt: Date; id: string } | null = null;

    for (;;) {
      if (options.signal?.aborted) break;
      // 每页取 min(剩余额度, PAGE) —— 额度在循环里收缩，最后一页不必多取。
      const pageSize = Math.min(EXECUTION_CSV_PAGE_SIZE, limit - written);
      if (pageSize <= 0) break;

      const qb = this.execRepo
        .createQueryBuilder("e")
        .select(executionListSelectColumnsAliased(this.execRepo))
        .orderBy("e.createdAt", "DESC")
        .addOrderBy("e.id", "DESC")
        .take(pageSize);
      // 过滤条件：唯一真值源（**绝不**在此复写 where 构造）。
      this.applyAllExecutionsFilters(qb, filters);
      if (lastCursor) {
        // 键集续页：行值比较（DB 值比 DB 值，微秒零损失，同 getAllExecutionsByKeyset）。
        qb.andWhere(
          `(e.createdAt, e.id) < (SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId)`,
          { cursorId: lastCursor.id },
        );
      }

      const rows: TaskExecution[] = await qb.getMany();
      if (rows.length === 0) break;

      const lines = rows.map((r) => executionToCsvRow(r));
      written += rows.length;
      // 一页一次 write（不是一行一次）：每行一个 write 会把系统调用放大到
      // 行数量级，而一页通常已是几十 KB，足够摊薄调用开销。
      await write(`${lines.join("\n")}\n`);

      if (written >= limit) break;
      if (rows.length < pageSize) break; // 已到末页
      const last = rows[rows.length - 1];
      lastCursor = { createdAt: last.createdAt, id: last.id };
    }

    // 有痕截断：达到上限即追加注释行。判据用 `>=`（不是 `>`）——"恰好取满
    // limit 行"时**无法区分**是否还有更多行（本循环取满即 break，不再多探
    // 一行），这种情况必须按"可能被截断"如实标注，绝不能让人误以为是全量。
    const truncated = written >= limit;
    if (truncated) {
      await write(`${csvTruncationMarker(limit)}\n`);
    }
    return { rows: written, truncated };
  }

  /**
   * `getAllExecutions` 的过滤条件装配（**唯一**真值源，OFFSET / keyset 两条
   * 路径共用——与 `buildTaskListWhere` 之于 `findAll` 是同一个先例）。
   *
   * 为什么必须是"一份"而不是各写一份：这些过滤器全是**放宽/收窄结果集**的
   * 条件（status/taskId/taskName/executorAddress/startTime/endTime）。两份实现
   * 一旦漂移，最典型的表现不是报错而是"两种分页模式返回的集合不同"——
   * 客户端从 OFFSET 整页翻到 keyset 后结果集**静默**变宽/变窄，且没有任何
   * 信号（`total` 也会跟着变）。那正是本仓反复在修的"静默损坏"。
   *
   * 本端点的排序键恒为 `(createdAt DESC, id DESC)`（无 sortBy 参数），故
   * 游标与全部过滤器都只是 AND 关系，不需要 `assertCursorCompatibleWithQuery`
   * 那样的可组合性拒绝。
   */
  private applyAllExecutionsFilters(
    qb: SelectQueryBuilder<TaskExecution>,
    p: {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
  ): void {
    if (p.status) qb.andWhere("e.status = :status", { status: p.status });
    if (p.taskId) qb.andWhere("e.taskId = :taskId", { taskId: p.taskId });
    if (p.taskName) {
      // taskName 过滤：命中执行行自身的 taskName，或命中 tasks 表名称
      //（保留 join 仅用于此过滤场景）
      // NETOPT-3⑤: API-09 同款转义——`_`/`%` 必须按字面量匹配（搜
      // `zhang_san` 不应命中 `zhangXsan`），否则搜索结果静默变宽、运维
      // 会据错误结果集得出错误结论。
      qb.leftJoin("tasks", "t", "t.id = e.taskId");
      qb.andWhere("(e.taskName ILIKE :taskName OR t.name ILIKE :taskName)", {
        taskName: `%${escapeLikePattern(p.taskName)}%`,
      });
    }
    if (p.executorAddress)
      // NETOPT-3⑤: 同上——执行器地址常含下划线/通配符字符，转义后按字面量匹配。
      qb.andWhere("e.executorAddress ILIKE :executorAddress", {
        executorAddress: `%${escapeLikePattern(p.executorAddress)}%`,
      });
    if (p.startTime)
      qb.andWhere("e.createdAt >= :startTime", { startTime: p.startTime });
    if (p.endTime)
      qb.andWhere("e.createdAt <= :endTime", { endTime: p.endTime });
  }

  /**
   * 一次性批量补齐缺失的 taskName（替代原 leftJoin + raw Map 组装）。
   *
   * OFFSET 与 keyset 两条路径共用：两条路径的响应形状必须一致，包括
   * `taskName` 的回填语义（行自身有值则优先，否则按 taskId 批量取 tasks.name）。
   */
  private async backfillExecutionTaskNames(
    list: TaskExecution[],
  ): Promise<Array<TaskExecution & { taskName: string | null }>> {
    const missingIds = [
      ...new Set(
        list
          .filter((e) => !e.taskName && e.taskId)
          .map((e) => e.taskId as string),
      ),
    ];
    const taskNameMap = new Map<string, string>();
    if (missingIds.length > 0) {
      const tasks = await this.taskRepo.find({
        where: { id: In(missingIds) },
        select: { id: true, name: true },
      });
      for (const t of tasks) taskNameMap.set(t.id, t.name);
    }

    return list.map((e) => ({
      ...e,
      taskName: e.taskName || taskNameMap.get(e.taskId) || null,
    }));
  }

  /**
   * §2.1（推广到 GET /tasks/executions/all）keyset 分支：
   * `(createdAt, id) < (游标行的库内原值)` 的元组游标翻页。
   *
   * 形态与 `getExecutionsByKeyset` / `findAllByKeyset` **逐字同款**（同一份
   * `decodeExecutionCursor` / `nextExecutionCursor`，同一个行值比较谓词），
   * 不重新设计。三处差异都是本端点固有的，不是随意的：
   *
   *   ① 过滤条件走 `applyAllExecutionsFilters`（六个全局过滤器，而不是单任务
   *      的 taskId/status）——与 OFFSET 分支共用同一份装配；
   *   ② 多取一行的判断用 `getCount()` 而不是 `getManyAndCount()`：后者在
   *      `taskName` 过滤生效时会带上 leftJoin，而 typeorm 的 `lazyCount` 在
   *      "有 join + 有 take" 时会退化成 `COUNT(DISTINCT e.id)`（见
   *      SelectQueryBuilder.lazyCount）——语义仍是"该过滤下的总行数"，但它是
   *      从**本页已取的 N+1 行**推算的，翻页越深越依赖它，白付一次 DISTINCT。
   *      拆成"页查询 getMany + 独立 getCount"则与 `getExecutionsByKeyset` 的
   *      `Promise.all([qb.getMany(), count()])` 完全同构，且 total 恒定等于
   *      同过滤条件下的全量行数（不含游标下界——游标只决定"从哪继续"）。
   *   ③ taskName 回填复用 `backfillExecutionTaskNames`（与 OFFSET 分支同源）。
   *
   * 精度：`task_executions."createdAt"` 已核实为 `timestamp without time zone`
   * （information_schema.datetime_precision = 6，微秒）。游标只带 `id`，时间由
   * 子查询按主键取**库内原值**——DB 值比 DB 值，JS Date 的毫秒截断完全不参与
   * 运算，零精度损失。**不要**改回毫秒半开区间：完整证伪论证见
   * `getExecutionsByKeyset` 头注（真 PG 实测：那版会漏行/返回游标之前的行）。
   */
  private async getAllExecutionsByKeyset(
    p: PaginationDto & {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
    rawCursor: string,
  ) {
    // 空串 = 调用方显式声明的 keyset 起点（与 getExecutions / findAll 同款约定）；
    // 非空则必须是合法游标，否则 400 —— 绝不降级到 OFFSET 分支。
    const cursor = rawCursor === "" ? null : decodeExecutionCursor(rawCursor);

    const qb = this.execRepo
      .createQueryBuilder("e")
      .select(executionListSelectColumnsAliased(this.execRepo))
      // 排序键与游标元组必须同源（createdAt DESC, id DESC），否则"继续"的
      // 起点与结果集排序不符，翻页会漏/重。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC");

    // 过滤条件：与 OFFSET 分支共用同一份装配（单份真值源，杜绝漂移）。
    this.applyAllExecutionsFilters(qb, p);

    // total 必须在**加游标谓词之前**取：typeorm 的 executeCountQuery 只清
    // orderBy/groupBy/offset/limit/skip/take，**WHERE 原样保留**
    // （node_modules/typeorm/query-builder/SelectQueryBuilder.js:1856 实测），
    // 所以带着游标谓词去 count 得到的是「剩余条数」——第 1 页「共 11 条」、
    // 第 2 页「共 9 条」，用户在同一个筛选条件下看着总数凭空变少。
    // 原注释写的是「不含游标下界」，与实现相反（注释是对的意图，代码是错的）。
    const total = await qb.getCount();

    if (cursor) {
      // 元组游标——**行值比较**，游标那一行的精确 (createdAt, id) 由子查询按
      // 主键从库里取回（含微秒）。论证见 getExecutionsByKeyset 头注。
      //
      // 游标行被并发删除：子查询无行 → 比较得 NULL → WHERE 为假 → 本页为空，
      // 调用方看到 nextCursor: null 即视为翻完（安全地提前结束，不错行不重复）。
      qb.andWhere(
        `(e.createdAt, e.id) < (
           SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }

    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(p.pageSize + 1);

    // 两次查询**顺序**执行（不 Promise.all 同一个 qb）：getMany 会改写
    // expressionMap.queryEntity，与并发的 getCount 抢同一个可变对象不安全。
    const rows = await qb.getMany();

    const hasMore = rows.length > p.pageSize;
    const list = hasMore ? rows.slice(0, p.pageSize) : rows;
    const items = await this.backfillExecutionTaskNames(list);
    return paginate(items, total, 1, p.pageSize, {
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      // 内层取原始行 list（不是 items）——编游标只读 (createdAt, id)。
      nextCursor: hasMore ? nextExecutionCursor(list) : null,
    });
  }

  /**
   * AI-powered schedule suggestion.
   * Reads the last 50 executions and asks the LLM to recommend an optimal cron expression.
   */
  async suggestSchedule(
    taskId: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<{
    taskId: string;
    currentCron: string | null;
    suggestedCron: string;
    reasoning: string;
    fallback?: boolean;
  }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new AppError("TASK_NOT_FOUND", { taskId });
    // A2-B: 本端点声明 scope='ownership'，此前完全未校验（任意登录用户可拉取
    // 他人任务的执行历史交给 AI 分析）；补上与 update 同档的属主守卫。
    await this.assertCanWriteProjectAware(task, user);

    const executions = await this.execRepo.find({
      where: { taskId },
      order: { createdAt: "DESC" },
      take: 50,
    });

    const successCount = executions.filter(
      (e) => e.status === ExecutionStatus.SUCCESS,
    ).length;
    const failCount = executions.filter(
      (e) =>
        e.status === ExecutionStatus.FAILED ||
        e.status === ExecutionStatus.TIMEOUT,
    ).length;
    const durations = executions
      .filter((e) => e.duration != null)
      .map((e) => e.duration!);
    const avgDuration =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    const p95Duration =
      durations.length > 0
        ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)]
        : 0;

    // Build time-of-day distribution for successes
    const hourCounts: number[] = new Array(24).fill(0);
    executions
      .filter((e) => e.status === ExecutionStatus.SUCCESS)
      .forEach((e) => {
        const h = new Date(e.createdAt).getUTCHours();
        hourCounts[h]++;
      });
    const bestHours = hourCounts
      .map((c, h) => ({ h, c }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 3)
      .map(({ h }) => h);

    const summaryLog = [
      `Task: ${task.name} (${task.id})`,
      `Current cron: ${task.cronExpression || "none"}`,
      `Total executions sampled: ${executions.length}`,
      `Successes: ${successCount}, Failures/Timeouts: ${failCount}`,
      `Avg duration: ${avgDuration}ms, P95 duration: ${p95Duration}ms`,
      `Timeout setting: ${task.timeout || "default"}ms`,
      `Hours with most successes (UTC): ${bestHours.join(", ")}`,
    ].join("\n");
    this.logger.debug(`Schedule optimization sample:\n${summaryLog}`);

    const { suggestedCron, reasoning, fallback } =
      await this.aiService.suggestSchedule(
        task.name,
        task.cronExpression || null,
        {
          total: executions.length,
          successes: successCount,
          failures: failCount,
          avgDurationMs: avgDuration,
          p95DurationMs: p95Duration,
          bestHoursUtc: bestHours,
        },
      );

    return {
      taskId: task.id,
      currentCron: task.cronExpression || null,
      suggestedCron,
      reasoning,
      // AI-002: 透传 fallback 标记，调用方可区分「AI 建议」与「回退到当前值」
      fallback,
    };
  }

  async getExecutionStats(taskId: string) {
    // FIX-5.1: 统计口径收口——此前 successRate 只按「最近 20 次」窗口计算，
    // 而 totalRuns 是全量口径；前端 failedRunCount = totalRuns×(1−rate) 把
    // 两个窗口混在一起派生「失败次数」（历史 500 败 + 最近 20 全成 → 显示
    // 「失败 0 次」）。现后端以一条 GROUP BY 给出**全量**计数（succeeded/
    // failed/successRate 全量口径），近窗成功率保留为 recentSuccessRate
    // （窗口标注见前端卡片），前端不再自行派生失败数。
    // FIX-5.2: recentExecutions 加读投影（复用列表读面排除 logs/aiAnalysis，
    // 并追加排除 result——jsonb 大对象列：广播执行带 acceptedResults 数组、
    // 解释器快照等，统计卡只消费 status/duration）。
    const [recent, statusRows, total] = await Promise.all([
      this.execRepo.find({
        where: { taskId },
        order: { createdAt: "DESC", id: "DESC" },
        take: 20,
        select: this.executionStatsSelect(),
      }),
      this.execRepo
        .createQueryBuilder("e")
        .select("e.status", "status")
        .addSelect("COUNT(*)", "count")
        .where("e.taskId = :taskId", { taskId })
        .groupBy("e.status")
        .getRawMany(),
      this.execRepo.count({ where: { taskId } }),
    ]);
    const byStatus = new Map<string, number>(
      statusRows.map((r) => [String(r.status), Number(r.count) || 0]),
    );
    const succeeded = byStatus.get(ExecutionStatus.SUCCESS) ?? 0;
    // 失败口径 = FAILED + TIMEOUT（与失败类终态语义一致；killed/cancelled
    // 是人工/调度动作，不计入任务自身的失败率）。
    const failed =
      (byStatus.get(ExecutionStatus.FAILED) ?? 0) +
      (byStatus.get(ExecutionStatus.TIMEOUT) ?? 0);
    const successRate =
      total > 0 ? Math.round((succeeded / total) * 1000) / 10 : 0;
    const recentSucceeded = recent.filter(
      (e) => e.status === ExecutionStatus.SUCCESS,
    ).length;
    const recentSuccessRate =
      recent.length > 0
        ? Math.round((recentSucceeded / recent.length) * 1000) / 10
        : 0;
    const durations = recent
      .filter((e) => e.duration != null)
      .map((e) => e.duration!);
    const avgDuration =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    return {
      recentExecutions: recent,
      // 近 20 次窗口口径（保留给趋势参考；字段名即窗口标注）。
      recentSuccessRate,
      // 全量口径（FIX-5.1 起为权威；successRate 语义自「近 20 次」切换为
      // 全量——消费方 TaskDetailPage 同批更新）。
      successRate,
      succeeded,
      failed,
      avgDuration,
      totalRuns: total,
    };
  }

  /** FIX-5.2: 统计卡读投影 = 列表投影 − result（大对象 jsonb 列）。 */
  private executionStatsSelect(): Record<string, true> {
    const select = executionListSelectMap(this.execRepo);
    delete select.result;
    return select;
  }

  async getExecution(id: string, taskId?: string) {
    const e = await this.execRepo.findOne({
      where: taskId ? { id, taskId } : { id },
    });
    if (!e) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId: id,
      });
    }
    return e;
  }

  /**
   * OBS-04: 执行报告端点读侧——单次响应合并三类数据，供详情页
   * 「分析报告/时间线」Tab 一次拉取渲染：
   *
   * 1. execution：task_executions 行原样返回（含 createdAt/startTime/endTime/
   *    duration/status/triggerType/executorAddress/aiAnalysis 等时间线与 AI
   *    分析字段——时间线由前端从此行的时间戳列映射，保证与 DB 一致）；
   * 2. timeline：与 mcp-server buildExecutionTimeline 同一语义的三段时刻
   *    （created→started→finished；缺省时刻 at=null，前端显示「—」）；
   * 3. report：metrics.execution_reports 当日聚合行（triggerDay=execution
   *    createdAt 的本地日期）。该表由 MetricsService.generateReport 按"日"
   *    聚合写入，与单次执行无外键关系，故只按日期粗粒度关联；无行时返回
   *    report:null（前端降级渲染——本表写入方是手动触发的 today-report
   *    读取路径，环境里常为空表，缺报告属正常态而非错误）。
   */
  async getExecutionReport(id: string, taskId?: string) {
    const execution = await this.getExecution(id, taskId);
    // execution_reports.triggerDay 是 DATE 列（无时间成分）：把执行的
    // createdAt 截到本地零点做等值匹配，避免时区偏移导致查不到当日行。
    // 仓储未注册（@Optional 回退）时同样返回 null——前端按"无报告"降级。
    let report: ExecutionReport | null = null;
    if (this.reportRepo) {
      const day = new Date(execution.createdAt);
      day.setHours(0, 0, 0, 0);
      report = await this.reportRepo.findOne({
        where: { triggerDay: day },
      });
    }
    return {
      execution,
      timeline: buildExecutionTimeline(execution),
      report: report ?? null,
    };
  }

  /**
   * On-demand AI analysis for an execution.
   * Fetches the task by name, runs analyzeFailure with the execution logs,
   * persists the result, and returns the updated execution.
   */
  async analyzeExecution(
    execId: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<TaskExecution> {
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId: execId,
      });
    }
    // A2-B: 同上——声明 'ownership' 却无校验的缺口，补属主守卫。
    await this.assertCanWriteExecution(exec, user);
    // Use errorMessage + logs as analysis input; fall back gracefully when logs are empty
    const logContent =
      [exec.errorMessage, exec.logs].filter(Boolean).join("\n") || "(no logs)";
    // FIX-6.2: prompt 上下文补全——runtime 此前恒传 "unknown"（AI 拿不到真实
    // 运行时，结论泛化）；现从任务行取真实 runtime，并带上平台已判定的
    // failureReason / exitCode 与任务级 runbook（与通知链路同源）。任务行
    // 不可得（软删/无 taskId）时逐字段退化为旧行为，端点语义零破坏。
    const taskRow = exec.taskId
      ? await this.taskRepo.findOne({ where: { id: exec.taskId } })
      : null;
    const task = {
      name: taskRow?.name ?? exec.taskName ?? "unknown",
      runtime: taskRow?.runtime ?? "unknown",
    };
    // ARCH-30: 走服务化封装（重试 1 次 + 指标 + 永不抛错）；空串结果原样
    // 落库（前端按"无分析"降级渲染），与此前直调 AiService 的空串语义一致。
    const analysis = await this.aiAnalysisService.analyzeFailure(
      task,
      logContent,
      {
        failureReason: exec.failureReason ?? null,
        exitCode: typeof exec.exitCode === "number" ? exec.exitCode : null,
        runbook: taskRow?.runbook ?? null,
      },
    );
    // R46-A1（四轴审计 · ADR-026 规则 4）：**只写本次动作真正改变的列**。
    //
    // 旧实现是 `this.execRepo.save(exec)`——把方法早期读到的**执行行快照**整行
    // 回写。AI 调用是秒级甚至更长的窗口，窗口内执行器回调 / 管理员 kill /
    // 超时扫描完全可能已把该行推进到终态；整行 save 会把 status / endTime /
    // exitCode / duration / failureReason 全部按旧值盖回去，于是：
    //   · 终态 SUCCESS/KILLED 被"复活"成 RUNNING（**终态之后仍可改写**）；
    //   · 随后 scheduler 的 stale sweep 把这条"RUNNING 但没心跳"的行当丢失
    //     执行重新入队 → 同一个执行被**二次派发**；
    //   · 本次真正要落库的其实只有 aiAnalysis 一列，且它是纯展示列、无并发写者。
    // 故单列 UPDATE 足够，且天然无竞态（行级锁只作用于这一列）。
    // adr-026-exempt: 只写 aiAnalysis 一个**纯展示列**，patch 里不含 status/endTime/
    // exitCode 等状态列；状态迁移由 execution-terminal 的条件 UPDATE 独占。
    await this.execRepo.update({ id: exec.id }, { aiAnalysis: analysis });
    // 返回读侧视图：取库中当前行而不是方法早期快照，避免把窗口内已经变化的
    // status/endTime 一并回给前端（会让详情页显示"已完成但仍 RUNNING"）。
    const fresh = await this.execRepo.findOne({ where: { id: exec.id } });
    return fresh ?? { ...exec, aiAnalysis: analysis };
  }

  /**
   * Paged execution log fetch.
   *
   * OBS-03: `level`（可选，ERROR/WARN/INFO/DEBUG）为等值过滤：
   * - DB 路径在 SQL 层下推（level = :level），与 fromLine/limit 同一语义；
   * - totalLines / hasMore 按"过滤后"的行集计算——分页元数据必须描述
   *   调用方实际能翻到的行，而不是全量行数（CODE-01 语义在过滤下的自然
   *   延伸）；
   * - level=null（未过滤）时行为与 OBS-03 之前完全一致；
   * - 过滤时 level IS NULL 的行（存量行/推断不到的行 = 未知级别）不返回。
   */
  /**
   * 日志读的分区窗口（第 6 轮八域审计 P1）。
   *
   * `execution_log_lines` 按 `createdAt` RANGE 分区，但读路径此前只按
   * executionId 过滤——PG 无法裁剪，每次读都会对**全部日分区**各做一次索引
   * 扫描（默认保留 30 天 ⇒ ×31 放大）。日志行只会落在执行开始到终态附近，
   * 用「开始-1h ~ (终态 ?? now)+1h」作分区键范围：仍覆盖时钟偏移/重试写入，
   * 同时把扫描限制在 1-2 个分区。exec 缺失时退化为「epoch ~ now+1h」。
   */
  private logPartitionWindow(
    exec:
      | Pick<TaskExecution, "startTime" | "createdAt" | "endTime">
      | null
      | undefined,
  ): { since: Date; until: Date } {
    const HOUR = 60 * 60 * 1000;
    const base = exec?.startTime ?? exec?.createdAt ?? null;
    const since = base
      ? new Date(new Date(base).getTime() - HOUR)
      : new Date(0);
    const until = exec?.endTime
      ? new Date(new Date(exec.endTime).getTime() + HOUR)
      : new Date(Date.now() + HOUR);
    return { since, until };
  }

  async getExecutionLogs(
    execId: string,
    fromLine = 0,
    limit = 500,
    level?: string | null,
  ) {
    // Cap limit to prevent accidental memory exhaustion
    const safeLimit = Math.min(Math.max(1, limit), 2000);
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId: execId,
      });
    }
    const logWindow = this.logPartitionWindow(exec);
    // LOG-02 + High-6.1: S3-stored logs are streamed line-by-line so we never
    // hold the full decompressed payload in memory; DB rows remain the
    // fallback (and the db-driver path).
    if (exec.logStorage === "s3" && exec.logObjectKey) {
      try {
        const s3 = this.resolveS3Storage();
        if (s3) {
          const stream = await s3.getStream(exec.logObjectKey);
          const result = await paginateLogStream(stream, fromLine, safeLimit, {
            level: level ?? null,
          });
          return result;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to read S3 logs for execution ${execId} (${err instanceof Error ? err.message : String(err)}) — falling back to DB log lines`,
        );
      }
    }
    // N10: use typed logLineRepo instead of string-based getRepository
    // CODE-01: fetch true total in parallel so pagination metadata is accurate
    // OBS-03: level 过滤在 SQL 层下推（level = :level）；未传 level 时查询
    // 形态与 OBS-03 之前完全一致（行号游标 + 全量 count），存量行为不变。
    const qb = this.logLineRepo
      .createQueryBuilder("l")
      .where("l.executionId = :id", { id: execId })
      // P1（第 6 轮）：分区键范围——让 PG 只扫执行窗口覆盖的分区。
      .andWhere("l.createdAt >= :logSince AND l.createdAt <= :logUntil", {
        logSince: logWindow.since,
        logUntil: logWindow.until,
      });
    if (level) {
      qb.andWhere("l.level = :level", { level });
    } else {
      qb.andWhere("l.lineNumber >= :from", { from: fromLine });
    }
    // OBS-03: level 过滤后行集不再按 lineNumber 连续，行号游标
    // （lineNumber >= from）会让 fromLine += lines.length 的既有客户端翻页
    // 契约产生重复/漏行——过滤模式下 fromLine 语义切换为"过滤后序列的
    // 偏移量"（skip/OFFSET），与 S3 路径的读后过滤分页保持同一语义（见
    // api-reference.md）。未传 level 时绝不触碰 skip（行为不变）。
    const paged = qb
      .orderBy("l.lineNumber", "ASC")
      .select(["l.lineNumber", "l.content"])
      .take(safeLimit);
    const [lines, totalLines] = await Promise.all([
      (level ? paged.skip(fromLine) : paged).getMany(),
      // OBS-03: totalLines 与过滤语义一致——level 过滤时按 level 计数
      // （分页元数据描述的是调用方能翻到的行集），未过滤时保持全量计数。
      level
        ? this.logLineRepo.count({
            where: {
              executionId: execId,
              level,
              createdAt: Between(logWindow.since, logWindow.until),
            },
          })
        : this.logLineRepo.count({
            where: {
              executionId: execId,
              createdAt: Between(logWindow.since, logWindow.until),
            },
          }),
    ]);
    return {
      lines: lines.map((r) => r.content),
      // CODE-01: true total count, not (currentBatch + offset)
      totalLines,
      hasMore: fromLine + lines.length < totalLines,
    };
  }

  /**
   * TASK-008: SSE 日志流并发上限注册表。
   * 每个连接在开始轮询前必须持有槽位；连接结束（正常完成 / abort / 异常）
   * 时释放。两级限制防止大量客户端同时轮询把数据库打垮：
   * - 单 execution 最多 SSE_MAX_STREAMS_PER_EXECUTION 个连接；
   * - 全局最多 SSE_MAX_STREAMS_GLOBAL 个连接。
   */
  private sseStreamsPerExecution = new Map<string, number>();
  private sseStreamsGlobal = 0;

  private static readonly SSE_MAX_PER_EXECUTION_DEFAULT = 4;
  private static readonly SSE_MAX_GLOBAL_DEFAULT = 64;
  // FIX-3.1: 超时预警 SETNX 闸的 TTL——远大于任何执行生命周期，锁不释放
  // 即「每执行至多一次」的去重窗口（acf:timeout-warn:{executionId}）。
  private static readonly TIMEOUT_WARN_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * OBS3-03（第 3 轮观测审计）：SSE 容量 gauges 在**启动时**发布一次。
   *
   * 原实现只在 acquireSseSlot 成功时写 `autoflow_sse_streams_limit`——从未
   * 开过日志流的副本完全没有 limit series，容量告警的 `Σ(active)/Σ(limit)`
   * 分母缺项，占用率被放大最多「副本数」倍（与 README「per-instance 线性
   * 叠加」的承诺相反）。启动即发 active=0 + limit（配置值），每个副本都参与
   * 分母；活跃值仍由占用/释放两点更新。
   */
  onModuleInit(): void {
    setRuntimeGauge("autoflow_sse_streams_active", this.sseStreamsGlobal);
    setRuntimeGauge("autoflow_sse_streams_limit", this.sseMaxGlobal);
  }

  private get sseMaxPerExecution(): number {
    const raw = this.configService.get<number | string>(
      "sse.maxStreamsPerExecution",
    );
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0
      ? n
      : TaskService.SSE_MAX_PER_EXECUTION_DEFAULT;
  }

  private get sseMaxGlobal(): number {
    const raw = this.configService.get<number | string>("sse.maxStreamsGlobal");
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0 ? n : TaskService.SSE_MAX_GLOBAL_DEFAULT;
  }

  /** 尝试为 execId 占用一个 SSE 流槽位；超限抛 ServiceUnavailableException。 */
  acquireSseSlot(execId: string): () => void {
    const perExec = this.sseMaxPerExecution;
    const global = this.sseMaxGlobal;
    const currentForExec = this.sseStreamsPerExecution.get(execId) ?? 0;

    if (currentForExec >= perExec) {
      // 可观测性补齐：并发拒绝计数（autoflow_sse_streams_rejected_total）——
      // 只在超限抛错路径记录，成功占用不计数。
      recordRuntime("autoflow_sse_streams_rejected_total");
      throw new AppError("TASK_LOG_STREAM_LIMIT_PER_EXECUTION", {
        executionId: execId,
        max: perExec,
      });
    }
    if (this.sseStreamsGlobal >= global) {
      recordRuntime("autoflow_sse_streams_rejected_total");
      throw new AppError("TASK_LOG_STREAM_LIMIT_GLOBAL", {
        max: global,
      });
    }

    this.sseStreamsPerExecution.set(execId, currentForExec + 1);
    this.sseStreamsGlobal++;
    // BUG-05：活跃流 gauge（瞬时值）——占用/释放两点同步写，渲染侧
    // PrometheusMetricsService 读快照 set() 绝对值。limit 一并透出，
    // 抓取方可直接算占用率 active/limit。
    setRuntimeGauge("autoflow_sse_streams_active", this.sseStreamsGlobal);
    setRuntimeGauge("autoflow_sse_streams_limit", global);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.sseStreamsPerExecution.get(execId) ?? 1) - 1;
      if (n <= 0) this.sseStreamsPerExecution.delete(execId);
      else this.sseStreamsPerExecution.set(execId, n);
      this.sseStreamsGlobal = Math.max(0, this.sseStreamsGlobal - 1);
      setRuntimeGauge("autoflow_sse_streams_active", this.sseStreamsGlobal);
    };
  }

  /**
   * SSE log streaming: polls DB for new log lines while execution is running,
   * then flushes remaining lines and sends [DONE] when execution finishes.
   * Caller is responsible for writing SSE headers and closing the response.
   *
   * TASK-008: 受 acquireSseSlot 两级并发上限保护；无论正常结束、abort
   * 还是抛异常，finally 都会释放槽位。
   */
  async streamExecutionLogs(
    execId: string,
    send: (line: string) => void,
    done: () => void,
    signal: AbortSignal,
    preAcquiredSlot?: () => void,
    // QA3: raw-socket sink for SSE comment frames. The controller's `send`
    // wraps content in `data:` frames; the idle heartbeat must bypass that
    // wrapper so EventSource clients ignore the frame per the SSE spec.
    ping?: () => void,
  ): Promise<void> {
    // TASK-008: 控制器通常会在写出 SSE 响应头之前预先占用槽位
    // （preAcquiredSlot），以便超限时能返回真正的 503；未传入时在此补占。
    const releaseSlot = preAcquiredSlot ?? this.acquireSseSlot(execId);
    let nextLine = 0;
    let s3FetchFailed = false;
    const POLL_INTERVAL = 1000; // ms
    const MAX_RUNTIME = 30 * 60 * 1000; // 30 min safety cap
    // FIX-5.4: DB 路径单轮 flush 的行数上限（与 REST /logs safeLimit 同值）。
    const SSE_FLUSH_BATCH_LINES = 2000;
    // R-24（DEEP_REVIEW 0ef3bbe）: 空转退避——连续 N 次轮询无新日志后，
    // 指数增大查询间隔（上限 5s），有新数据立即恢复 1s 基线。64 并发流
    // 空转期从 128 QPS 底噪降至 ~12.8 QPS（5s 间隔）。最大 5s 保证新日志
    // 延迟可接受。
    const IDLE_BACKOFF_THRESHOLD = 3; // 连续 3 次无新数据后开始退避
    const IDLE_BACKOFF_MAX_INTERVAL = 5000; // ms 上限
    let idlePolls = 0;
    let pollWait = POLL_INTERVAL;
    // QA3: nginx proxy_read_timeout（默认 60s）会掐断空闲的 SSE 流——S3 存储
    // 的执行在到达终态前可能整分钟无任何新行。空闲超过 15s 时写一条注释帧
    // （": ping\n\n"）：SSE 规范要求客户端忽略注释行，因此 admin-web 的
    // EventSource 解析不受影响，但反向代理会把连接视为活跃。
    const IDLE_PING_INTERVAL = 15_000; // ms
    let lastWriteAt = Date.now();
    const write = (line: string) => {
      lastWriteAt = Date.now();
      send(line);
    };
    const start = Date.now();
    const TERMINAL_STATUSES = [
      ExecutionStatus.SUCCESS,
      ExecutionStatus.FAILED,
      ExecutionStatus.TIMEOUT,
      "killed",
      "cancelled",
    ] as string[];

    // FIX-3.1: 预警判定的任务配置缓存（同一条流只查一次任务行——timeout
    // 配置在单次执行生命周期内视为不变）。SSE 日志流轮询是 admin 内对
    // 「执行进行中」的周期性观察点：非终态轮次按 elapsed ≥ 阈值判定，
    // SETNX 闸保证每执行至多一次预警（见 maybeNotifyTimeoutWarning）。
    let warnTaskCache: { taskId: string; task: Task | null } | null = null;

    const flush = async (): Promise<boolean> => {
      // Returns true when execution is terminal and no more lines pending
      // rt-7：列级投影——本函数只读 status/taskId/logStorage/logObjectKey
      // （maybeNotifyTimeoutWarning 另需 id/startTime，见下注），而 `logs` 是
      // text 列（回调上限 512KB）、`result`/`params`/`artifacts` 是 jsonb、
      // `aiAnalysis` 是 text。此前每拍 findOne 取整行：64 条并发流 × 1/5s~1/1s
      // 即 13-64 次/秒把几十 KB 的无关列搬出库、并在进程内驻留（R-24 退避只
      // 降了空转 QPS，没降列宽）。投影后单次返回 <200B。
      const exec = await this.execRepo.findOne({
        where: { id: execId },
        select: {
          id: true,
          status: true,
          taskId: true,
          logStorage: true,
          logObjectKey: true,
          // startTime 不是「顺便带上」：下面的超时预警观察点
          // （maybeNotifyTimeoutWarning → `if (!exec.startTime) return`）与
          // elapsed 计算都依赖它，漏选会让预警静默失效。id 同理用于 SETNX 锁键。
          startTime: true,
        },
      });
      if (!exec) return true;

      // FIX-3.1: 超时预警观察点（终态轮次跳过——预警只对进行中的执行有意义）。
      if (!TERMINAL_STATUSES.includes(exec.status) && exec.taskId) {
        if (!warnTaskCache || warnTaskCache.taskId !== exec.taskId) {
          warnTaskCache = {
            taskId: exec.taskId,
            task: await this.taskRepo.findOne({ where: { id: exec.taskId } }),
          };
        }
        if (warnTaskCache.task) {
          await this.maybeNotifyTimeoutWarning(exec, warnTaskCache.task);
        }
      }

      // LOG-02: S3 objects are uploaded once at callback time, so their lines
      // become readable only after the execution reaches a terminal state;
      // stream whatever has not been sent yet, then stop.
      if (exec.logStorage === "s3" && exec.logObjectKey) {
        const terminal = TERMINAL_STATUSES.includes(exec.status);
        if (terminal && !s3FetchFailed) {
          try {
            const s3 = this.resolveS3Storage();
            if (s3) {
              // O-14/F-3：改用 getStream() 流式逐行回传，不再把整个日志对象
              // gunzip 成全量 Buffer/字符串驻留内存。按物理行索引跳过已推送行
              // （nextLine），流结束后把 nextLine 推进到总行数，与原全量
              // split("\n") + slice 的 SSE 协议/行分割语义一致。
              const stream = await s3.getStream(exec.logObjectKey);
              const rl = createInterface({
                input: stream,
                crlfDelay: Infinity,
              });
              let idx = 0;
              for await (const line of rl) {
                if (idx >= nextLine) write(line);
                idx++;
              }
              nextLine = idx;
            }
          } catch (err: unknown) {
            s3FetchFailed = true;
            this.logger.warn(
              `Failed to stream S3 logs for execution ${execId} (${err instanceof Error ? err.message : String(err)}) — stopping S3 streaming`,
            );
          }
        }
        return terminal;
      }

      // P1（第 6 轮）：与 REST 同款分区窗口——SSE 每 1s 一拍、并发 64 条时
      // 没有分区裁剪就是 31× 的分区索引探测。
      const sseLogWindow = this.logPartitionWindow(exec);
      const lines = await this.logLineRepo
        .createQueryBuilder("l")
        .where("l.executionId = :id", { id: execId })
        .andWhere("l.createdAt >= :logSince AND l.createdAt <= :logUntil", {
          logSince: sseLogWindow.since,
          logUntil: sseLogWindow.until,
        })
        .andWhere("l.lineNumber >= :from", { from: nextLine })
        .orderBy("l.lineNumber", "ASC")
        .select(["l.lineNumber", "l.content"])
        // FIX-5.4: 单轮 flush 行数上限（与 REST 端点 safeLimit 同值）——
        // 中途接入的观看者此前首轮会把「已产出的全部行」一次物化进内存并
        // 写出（数万行级执行的内存/网络尖峰）；分批 flush 由外层 while 驱动
        //（下一轮继续推进 nextLine），SSE 协议与行分割语义不变。
        .take(SSE_FLUSH_BATCH_LINES)
        .getMany();

      for (const row of lines) {
        write(row.content);
        nextLine = row.lineNumber + 1;
      }

      const terminal = [
        ExecutionStatus.SUCCESS,
        ExecutionStatus.FAILED,
        ExecutionStatus.TIMEOUT,
        "killed",
        "cancelled",
      ] as string[];
      // FIX-5.4: 「完成」= 已到终态 **且** 本轮未打满批——满批意味着可能还有
      // 待发行，即使终态也要再 flush 一轮直到排空（否则上限引入后终态执行的
      // 尾部日志会被截掉）。
      return (
        terminal.includes(exec.status) && lines.length < SSE_FLUSH_BATCH_LINES
      );
    };

    // Poll until done or aborted
    try {
      while (!signal.aborted && Date.now() - start < MAX_RUNTIME) {
        const lineBefore = nextLine;
        const finished = await flush();
        if (finished) break;
        // R-24: 空转退避——本轮 flush 是否产生新行？
        const hadNewLines = nextLine > lineBefore;
        if (hadNewLines) {
          // 有新数据：立即恢复 1s 基线
          idlePolls = 0;
          pollWait = POLL_INTERVAL;
        } else {
          idlePolls++;
          if (idlePolls > IDLE_BACKOFF_THRESHOLD) {
            // 指数退避，上限 IDLE_BACKOFF_MAX_INTERVAL
            pollWait = Math.min(pollWait * 2, IDLE_BACKOFF_MAX_INTERVAL);
          }
        }
        // QA3: idle heartbeat — checked inline in the polling loop instead of
        // via a separate timer, so when the connection closes (signal aborts)
        // the existing loop-exit path below tears the whole thing down with
        // no extra handle left to clean up.
        if (ping && Date.now() - lastWriteAt >= IDLE_PING_INTERVAL) {
          ping();
          lastWriteAt = Date.now();
        }
        // NETOPT-1⑦: 自然到期分支必须显式 removeEventListener——此前监听器
        // 只在 abort 时被消费（once），每轮轮询自然超时都会在 signal 上残留
        // 一个 abort 监听器（长流 × 秒级轮询 → 监听器线性泄漏）。成对移除，
        // 对齐 executions-stream.controller 的 waitCancellable 先例。
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, pollWait);
          const onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }

      // Final flush after terminal state
      if (!signal.aborted) {
        await flush();
      }
      done();
    } finally {
      // TASK-008: 连接关闭/异常时必须归还槽位，否则计数泄漏会逐渐耗尽上限
      releaseSlot();
    }
  }

  async rollback(
    id: string,
    dto: { gitCommit: string; params?: Record<string, any> },
    user?: { id: number; role: UserRole } | null,
  ) {
    // R-01: RAW 取数——事务内 manager.save(Task, task) 消费该实体，
    // findOne 的掩码副本会把 "******" 整体落库。
    const task = await this.findByIdRaw(id);
    // R-03: 写面归属守卫（镜像 update 口径——rollback 改写 gitCommit）。
    // rollback 同时触发执行，叠加执行类写面同一口径的 assertCanOperate
    // （仅拒绝项目 viewer，不为执行面新增更严语义）。
    await this.assertCanWriteProjectAware(task, user);
    await this.assertCanOperate(task, user);
    const prevCommit = task.gitCommit;

    const exec = await this.dataSource.transaction(async (manager) => {
      // R63-A1（ADR-026 规则 4）：这里此前是
      //   `task.gitCommit = dto.gitCommit; await manager.save(Task, task);`
      // ——把**方法早期读到的快照**整行写回：窗口内并发 PATCH 写的 name /
      // cronExpression / params、并发 pause 写的 status、并发 remove 写的
      // status='deleted' 与 deletedAt 都会被盖回旧值（save 连 deletedAt 一起写
      // NULL ⇒ 软删行复活）。本动作真正改变的列只有 gitCommit 一列。
      //
      // 行谓词带 deletedAt IS NULL（规则 1/2）：命中 0 = 行已被并发软删 ——
      // 按规则 3 让位（与"顺序执行时任务已不存在"同解：404），事务整体回滚，
      // 执行行也不会落库——不给已删除的任务再派一次执行。
      const applied = await manager.update(
        Task,
        { id: task.id, deletedAt: IsNull() },
        { gitCommit: dto.gitCommit },
      );
      if ((applied?.affected ?? 0) === 0) {
        throw new AppError("TASK_NOT_FOUND", { taskId: id });
      }
      // 内存视图同步（响应与版本快照取自该对象；写面已不再消费它）
      task.gitCommit = dto.gitCommit;

      // Create execution record
      return manager.save(
        manager.create(TaskExecution, {
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: dto.params ?? task.params,
          triggerType: "rollback",
          taskVersion: dto.gitCommit,
          // MUTEX-01：互斥组快照（task→application；未挂组为 null）。
          mutexGroupId: await resolveTaskMutexGroupId(manager, task),
        }),
      );
    });

    try {
      await this.taskQueue.add(
        "execute",
        { executionId: exec.id },
        {
          // Bull requires attempts >= 1; guard against maxRetry=0
          attempts: Math.max(1, task.maxRetry ?? 1),
          // CORE-02: delay 预乘指数基座并加 ±20% 抖动（首次尝试 attempt=1）。
          backoff:
            task.retryDelay > 0
              ? {
                  type: "exponential",
                  delay: jitteredRetryDelayMs(task.retryDelay, 1),
                }
              : undefined,
          // N2: normalized numeric priority (see trigger()).
          // A4: 再经方向换算——BullMQ 数值越小越先出队，DB 4=紧急 → 1。
          priority: toBullPriority(normalizeTaskPriority(task.priority)),
        },
      );
    } catch (err: unknown) {
      // P1: compensate the committed PENDING row so it cannot hang forever
      const message = err instanceof Error ? err.message : String(err);
      // A1: 入队失败补偿走统一终态门（W-7 窗口内无并发回调，但保持一致性）
      await transitionOneToTerminal(this.execRepo, {
        id: exec.id,
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage: `任务入队失败：${message}`,
          failureReason: ExecutionFailureReason.UNKNOWN,
        },
        from: [ExecutionStatus.PENDING],
      });
      // FIX-4.2: 补偿终态已落库，同样唤醒 webhook wait 等待方。
      this.publishExecutionWake(exec.id);
      this.logger.error(`Failed to enqueue execution ${exec.id}: ${message}`);
      throw new AppError("TASK_ENQUEUE_FAILED", { message });
    }
    await this.saveVersion(task.id, undefined, undefined, task);
    // N11: re-schedule so active cron/fixed-rate tasks pick up the new commit immediately
    if (task.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(task);
    }
    return {
      execution: exec,
      rolledBackFrom: prevCommit,
      rolledBackTo: dto.gitCommit,
    };
  }

  /**
   * ADR-017 阶段 3：同地址多行并存（pull 模式，ADR-017 §5）时按地址无界冲销会
   * 把**别人的** `runningTaskCount` 也减 1。委托共享 util（单一事实源）：地址
   * 命中多行时保守跳过。单行命中时行为与引入前逐字节一致。
   */
  private async releaseExecutorSlot(address?: string | null): Promise<void> {
    await releaseExecutorSlotByAddress(this.dataSource, address);
  }

  /**
   * FEAT-21: 读上游执行行的透传上下文（结构化子集）。行不存在/查询失败一律
   * 返回 null——透传是增强而非依赖，绝不阻断扇出主链。
   */
  private async loadUpstreamContext(
    executionId: string,
  ): Promise<UpstreamExecutionContext | null> {
    try {
      const row = await this.execRepo.findOne({
        where: { id: executionId },
        select: {
          id: true,
          status: true,
          result: true,
          errorMessage: true,
          failureReason: true,
          startTime: true,
          endTime: true,
          duration: true,
          executorAddress: true,
          exitCode: true,
        },
      });
      return row ? buildUpstreamContext(row) : null;
    } catch (err: unknown) {
      this.logger.warn(
        `FEAT-21: failed to load upstream execution ${executionId} for context injection: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * R4-P0: check and trigger tasks that depend on the completed task.
   * Invoked from handleCallback on the unique SUCCESS-transition winner path
   * (moved from TaskProcessor, where the exec.status === SUCCESS condition
   * could never be true). Best-effort: failures are logged, never propagated
   * to the callback result — the execution itself is already terminal.
   *
   * R4-P3: 下游触发前先做短窗 DB claim——两个上游依赖几乎同时成功时，
   * 两个回调的 checkDependencies 都可能读到"全部依赖已满足"的快照并各自
   * 触发下游；条件 UPDATE 的行级锁串行化保证只有一个赢家真正 trigger。
   *
   * NETOPT-3②（扇出静默丢失治理，迁移 1790000000030 depsFiredAt）：
   * - 单个下游 trigger() 失败不再中断其余扇出（此前外层 catch 一断全断），
   *   记为部分失败并**回滚该下游的 claim**（见 rollbackDependencyClaim）；
   * - 扇出全部成功（含"无可触发的下游"的空成功）后，条件 UPDATE 落
   *   depsFiredAt = now 标记；失败/部分失败刻意不落，留 NULL：
   *   handleCallback 的重复回调分支（affected=0）读到 SUCCESS + NULL 标记
   *   时重放本方法——覆盖「trigger 失败」「终态提交后扇出前崩溃」两类
   *   此前永久静默丢失的窗口。
   * - residual（如实记录）：不建周期对账 sweeper。执行器整批重试覆盖崩溃
   *   窗口；静默失败窗现可由 `depsFiredAt IS NULL 的 SUCCESS 行` + error
   *   日志观测。并发双重复回调下"败者先落标记、胜者 trigger 失败"的窄
   *   竞态仍可丢一次扇出（标记语义是"扇出尝试已收敛"），不做跨行协议。
   *
   * @param completedTaskId   完成（SUCCESS）的上游任务 id
   * @param completedExecutionId 上游执行行 id——用于落 depsFiredAt 标记
   */
  private async triggerDependentTasks(
    completedTaskId: string,
    completedExecutionId?: string,
    // G6：上游终态。非 SUCCESS 时只扇出声明了 `runOnUpstreamFailure` 的下游
    //（失败补偿/清理链）；未声明的下游保持既有语义（失败不触发）。
    completedStatus: ExecutionStatus = ExecutionStatus.SUCCESS,
  ) {
    let fanoutFailed = false;
    try {
      // Find tasks that list completedTaskId as one of their dependency values.
      //
      // B-3（调度域审计）：旧实现对 `dependencies IS NOT NULL` 的全部任务做
      // 无 take 全表拉取后内存过滤——每次 SUCCESS 回调唯一赢家分支都要把
      // 全量有依赖的任务行物化进内存，行数随业务线性增长。现改为 JSONB
      // containment 谓词把过滤下推到 SQL，吃迁移
      // 1790000000053（idx_tasks_dependencies_values_gin，表达式
      // jsonb_path_query_array(dependencies,'$.keyvalue().value') 上的 GIN
      // jsonb_path_ops 索引）：
      // - dependencies 契约 = {显示名: 上游任务id}（FIX-1.1 / 迁移 0048），
      //   **value 才是依赖任务 id**；「任一 value == completedTaskId」对
      //   object 形态没有直接的列级 @> 形态（键未知），故用 IMMUTABLE 表达式
      //   （PG13+ 起 jsonb_path_query_array 非 _tz 变体为 IMMUTABLE）把 values
      //   投影成数组后做数组包含 `@> '["<id>"]'`——索引表达式与谓词左操作数
      //   逐字对齐（对齐关系由迁移 spec 断言，漂移即红）。
      // - 内存过滤保留为兜底（下方 filter）：谓词与索引漂移 / 脏形态行时
      //   行为与旧实现一致，不因优化引入漏扇出。
      // - jsonb_typeof 守卫把数组/标量等脏形态挡在 jsonpath 之外。
      const depProbe = JSON.stringify([completedTaskId]);
      const candidateTasks = await this.taskRepo
        .createQueryBuilder("t")
        .select([
          "t.id",
          "t.dependencies",
          "t.params",
          // G6：失败边筛选需要该列（未声明 = 失败不扇出）
          "t.runOnUpstreamFailure",
        ])
        .where("t.dependencies IS NOT NULL")
        .andWhere("jsonb_typeof(t.dependencies) = 'object'")
        .andWhere(
          "jsonb_path_query_array(t.dependencies, '$.keyvalue().value') @> CAST(:depProbe AS jsonb)",
          { depProbe },
        )
        .getMany();

      // Keep only tasks that list completedTaskId as one of their dependency values
      // （B-3: 内存兜底过滤，语义与旧实现逐字节一致）
      const dependentTasks = candidateTasks.filter(
        (t) =>
          t.dependencies &&
          Object.values(t.dependencies).includes(completedTaskId) &&
          (completedStatus === ExecutionStatus.SUCCESS ||
            t.runOnUpstreamFailure === true),
      );

      // FEAT-21: 上游执行上下文（opt-in 哨兵注入用）。**查询门**：仅当本批
      // 下游有任务声明哨兵时才读上游执行行——无人 opt-in 的存量扇出零新增
      // 查询；行缺席（历史防御分支）时 ctx=null，哨兵按"未声明"处理。
      const upstreamCtx =
        completedExecutionId &&
        dependentTasks.some((t) => paramsDeclareUpstreamSentinel(t.params))
          ? await this.loadUpstreamContext(completedExecutionId)
          : null;

      // G6 第二步：别名哨兵需要「每个依赖的最新执行」。只在有下游声明别名时
      // 才批量取（一次 IN 查询 + 500 行帽，与依赖闸门同口径）；无别名声明
      // 的存量扇出零新增查询。
      const aliasDeclared = dependentTasks.some((t) =>
        paramsDeclareUpstreamAlias(t.params),
      );
      const latestByDependency = new Map<string, TaskExecution>();
      if (aliasDeclared) {
        const dependencyIds = [
          ...new Set(
            dependentTasks.flatMap((t) => Object.values(t.dependencies ?? {})),
          ),
        ].filter((id): id is string => typeof id === "string");
        if (dependencyIds.length > 0) {
          const recent = await this.execRepo.find({
            where: { taskId: In(dependencyIds) },
            order: { createdAt: "DESC" },
            take: MAX_DEPENDENCY_EXECUTION_SCAN,
          });
          for (const row of recent) {
            if (!latestByDependency.has(row.taskId)) {
              latestByDependency.set(row.taskId, row);
            }
          }
        }
      }

      // NETOPT-4②（本轮）: prevLastTriggerTime 批读——旧实现进循环逐下游
      // findOne，扇出 D 个下游就是 D 条点查；现循环外一条 In() 批量取回。
      // 把读取提到循环外是安全的：rollbackDependencyClaim 的 CAS WHERE 钉住
      // lastTriggerTime = 本次 claimedAt——批读与 claim 之间若有并发赢家推进
      // 了 lastTriggerTime，本侧 claim 的 recency 条件（IS NULL OR < 窗口起点）
      // 必然失败（跳过、不走回滚）；claim 成功后 trigger 失败时若又有人推进，
      // 回滚 CAS 不命中自然 no-op。陈旧 prev 任何情形下都写不回去。
      const prevLastTriggerTimeById = new Map(
        dependentTasks.length
          ? (
              await this.taskRepo.find({
                where: { id: In(dependentTasks.map((t) => t.id)) },
                select: { id: true, lastTriggerTime: true },
              })
            ).map((row) => [row.id, row])
          : [],
      );

      for (const task of dependentTasks) {
        // Check if all dependencies are satisfied
        const canTrigger = await this.checkDependencies(task);
        if (!canTrigger) continue;

        // NETOPT-3②/4②: claim 前先读原 lastTriggerTime，trigger 失败时按它
        // 回滚（CAS 保护见 rollbackDependencyClaim）——原值已循环外批读
        //（NETOPT-4②）；行已删除时 get 不到 → 按 NULL 回滚（与旧 findOne
        // 返回 undefined 的行为一致）。
        const prevLastTriggerTime = prevLastTriggerTimeById.get(task.id);
        // R4-P3: short-window DB claim — exactly one concurrent fan-out wins.
        const claimedAt = await this.claimDependencyTrigger(task.id);
        if (!claimedAt) {
          this.logger.log(
            `Dependency trigger for task ${task.id} claimed by a concurrent fan-out within the dedup window, skip`,
          );
          continue;
        }
        this.logger.log(
          `All dependencies satisfied for task ${task.id}, triggering`,
        );
        // R-28（DEEP_REVIEW 0ef3bbe）: 依赖触发链路补审计日志，triggerType 记为
        // "dependency" 而非 "manual"——旧实现 this.trigger(task.id, {}) 使下游执行
        // 行 triggerType 错记 manual、且因无 user 主体绕过控制器审计。这里：
        // ① 透传 triggerType="dependency"；② best-effort 写一条系统审计（无 user
        // 主体，username 标 system:dependency；审计自身抛错绝不影响主链触发）。
        // FEAT-21: 哨兵命中才注入（走 dto.params 覆盖语义）；未声明哨兵的
        // 下游保持 this.trigger(id, {}) 逐字节不变。注入后总体积超
        // TASK_PARAMS_MAX_BYTES 时放弃注入（warn + 默认 params 触发）——
        // 上游 result 过大不该阻断扇出。
        let triggerPayload: { params?: Record<string, unknown> } = {};
        // 别名上下文：本任务 dependencies 的每个别名 → 最新执行（本次触发的
        // 上游直接用刚完成的执行行，避免与 latest 查询结果不一致）。
        const aliasCtxs: Record<string, UpstreamExecutionContext | null> = {};
        if (aliasDeclared && task.dependencies) {
          for (const [alias, depId] of Object.entries(task.dependencies)) {
            if (typeof depId !== "string" || depId.length === 0) continue;
            if (depId === completedTaskId && upstreamCtx) {
              aliasCtxs[alias] = upstreamCtx;
            } else {
              const row = latestByDependency.get(depId);
              aliasCtxs[alias] = row ? buildUpstreamContext(row) : null;
            }
          }
        }
        const injected = injectUpstreamContext(
          task.params,
          upstreamCtx,
          aliasCtxs,
        );
        if (injected !== null && injected !== task.params) {
          let injectedSize = 0;
          try {
            injectedSize = Buffer.byteLength(
              JSON.stringify(injected) ?? "",
              "utf8",
            );
          } catch {
            injectedSize = TASK_PARAMS_MAX_BYTES + 1;
          }
          if (injectedSize > TASK_PARAMS_MAX_BYTES) {
            this.logger.warn(
              `FEAT-21: upstream context injection for task ${task.id} exceeds ${TASK_PARAMS_MAX_BYTES} bytes — falling back to default params`,
            );
          } else {
            triggerPayload = { params: injected };
          }
        }
        try {
          await this.trigger(task.id, triggerPayload, null, "dependency");
        } catch (triggerErr) {
          // N-14：discard 闸门命中（同参在跑）= 有意的抑制而非链路故障——
          // 与一般失败同走 claim 回滚（depsFiredAt 留 NULL 供重放，活跃执行
          // 完成前的下一次完成会再扇出），但降级为 warn 且不计 fanoutFailed
          // （扇出主链没有故障）。
          if (triggerErr instanceof ConflictException) {
            await this.rollbackDependencyClaim(
              task.id,
              claimedAt,
              prevLastTriggerTime?.lastTriggerTime ?? null,
            );
            this.logger.warn(
              `Dependency trigger for task ${task.id} rejected by blockStrategy=discard (same-params active run) — claim rolled back for replay`,
            );
            continue;
          }
          // NETOPT-3②: trigger 失败 → 回滚 claim（缩小不可重试窗口）+ 部分
          // 失败标记（不落 depsFiredAt），并继续扇出其余下游（不改变回调
          // item 的 success 语义——终态已落定，扇出是旁路 best-effort）。
          fanoutFailed = true;
          await this.rollbackDependencyClaim(
            task.id,
            claimedAt,
            prevLastTriggerTime?.lastTriggerTime ?? null,
          );
          this.logger.error(
            `NETOPT-3②: dependency trigger failed for task ${task.id}; claim rolled back, depsFiredAt left NULL for replay: ${
              triggerErr instanceof Error
                ? triggerErr.message
                : String(triggerErr)
            }`,
          );
          continue;
        }
        try {
          await this.audit?.log({
            username: "system:dependency",
            action: "task.trigger_dependency",
            resource: "task",
            resourceId: task.id,
            detail: {
              triggerType: "dependency",
              upstreamTaskId: completedTaskId,
              dependencyTaskIds: Object.values(task.dependencies ?? {}),
            },
          });
        } catch (auditErr) {
          this.logger.warn(
            `R-28: dependency-trigger audit write failed for task ${task.id} (best-effort, ignored): ${
              auditErr instanceof Error ? auditErr.message : String(auditErr)
            }`,
          );
        }
      }
    } catch (err) {
      // NETOPT-3②: 扫描/判定层失败同样视为扇出未完成——不落标记，留给
      // 重复回调重放。
      fanoutFailed = true;
      this.logger.error(
        `Failed to trigger dependent tasks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // NETOPT-3②: 扇出全部成功才落 depsFiredAt（失败/部分失败不落）。
    if (!fanoutFailed && completedExecutionId) {
      await this.markDependencyFanoutComplete(completedExecutionId);
    }
  }

  /**
   * NETOPT-3②: 扇出全部成功后的完成标记（幂等条件 UPDATE：仅当仍为 NULL
   * 时落 now）。best-effort：标记写失败只记日志——重复回调的重放判据读
   * 不到标记时宁可多重放一次（扇出自身有 claim 去重，重放是安全的）。
   */
  private async markDependencyFanoutComplete(
    executionId: string,
  ): Promise<void> {
    try {
      await this.execRepo.update(
        { id: executionId, depsFiredAt: IsNull() },
        { depsFiredAt: new Date() },
      );
    } catch (err) {
      this.logger.warn(
        `NETOPT-3②: failed to mark depsFiredAt on execution ${executionId} (replay will re-attempt): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * NETOPT-3②: claimDependencyTrigger 的失败补偿——把 lastTriggerTime 回滚
   * 到 claim 前的原值（prev 为 NULL 时恢复 NULL）。CAS 保护：WHERE 钉住
   * 本次的 claimedAt，若期间又有并发写（另一个扇出/调度触发）推进了
   * lastTriggerTime，则本次回滚 no-op——绝不覆盖他人的新状态。
   */
  private async rollbackDependencyClaim(
    taskId: string,
    claimedAt: Date,
    prev: Date | null,
  ): Promise<void> {
    try {
      await this.taskRepo
        .createQueryBuilder()
        .update(Task)
        .set({ lastTriggerTime: prev })
        .where('"id" = :id AND "lastTriggerTime" = :claimedAt', {
          id: taskId,
          claimedAt,
        })
        .execute();
    } catch (err) {
      this.logger.warn(
        `NETOPT-3②: dependency claim rollback failed for task ${taskId} (claim stays, window-limited): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * R4-P3: 依赖扇出的短窗 DB claim（参考 scheduler.service claimTaskTrigger
   * 的条件 UPDATE 思路）：仅当 tasks.lastTriggerTime 在去重窗口之外（或为
   * NULL）时才允许本调用推进它并获得触发权；affected=0 表示窗口内已有
   * 并发赢家（另一个 fan-out、或紧邻的一次调度触发），本次跳过。
   *
   * NETOPT-3②: 返回值从 boolean 改为本次 claim 写入的时间戳（失败返回
   * null）——trigger() 失败时 rollbackDependencyClaim 需要它做 CAS 回滚。
   *
   * 权衡（选 lastTriggerTime 而非新增列的最小侵入方案）：
   * - 免去新列 + 迁移；复用 scheduler 已在写的列。
   * - 副作用 1：调度成功触发也会写 lastTriggerTime（scheduler.enqueue），
   *   因此"依赖满足"前的 DEPENDENCY_TRIGGER_CLAIM_WINDOW_MS 内若有调度
   *   触发，本次依赖触发会被吸收（视作合并去重）。窗口只有 10s，且语义
   *   上等价于"下游刚跑过就不重复跑"，可接受。
   * - 副作用 2：依赖触发会推进 lastTriggerTime，使 checkMisfires 的缺口
   *   从最近一次依赖触发起算——方向安全（更不容易误报 misfire）。
   * - 不加 status 门：与既有行为一致（PAUSED 下游当前也会被依赖触发），
   *   本方法只负责去重，不改变可触发性。
   */
  private async claimDependencyTrigger(taskId: string): Promise<Date | null> {
    const windowStart = new Date(
      Date.now() - DEPENDENCY_TRIGGER_CLAIM_WINDOW_MS,
    );
    const claimedAt = new Date();
    const result = await this.taskRepo
      .createQueryBuilder()
      .update(Task)
      .set({ lastTriggerTime: claimedAt })
      .where(
        '"id" = :id AND ("lastTriggerTime" IS NULL OR "lastTriggerTime" < :windowStart)',
        { id: taskId, windowStart },
      )
      .execute();
    return (result?.affected ?? 0) > 0 ? claimedAt : null;
  }

  /**
   * Check if all dependencies of a task have completed successfully.
   * B-6: 判定体抽至 dependency-gate.util（scheduler 的 misfire 补偿闸共用
   * 同一实现，两处永不漂移）；本方法保留为扇出路径的语义入口。
   */
  private async checkDependencies(task: Task): Promise<boolean> {
    return areDependenciesSatisfied(this.execRepo, task.dependencies, {
      acceptFailure: task.runOnUpstreamFailure === true,
    });
  }

  /**
   * Persist detailed execution logs (idempotent on retry).
   * DB driver: delete stale lines then bulk-insert in chunks (replace), or
   * plain bulk-insert when `append` is set (multi-page backfill pages 2+).
   * R4-P2: the delete + chunked inserts run inside ONE transaction, for both
   * append and replace modes — previously a mid-insert failure (connection
   * blip, constraint violation) left the execution with its old rows already
   * deleted and only a partial page persisted. Any failure now rolls the
   * whole call back, so the pre-call rows survive untouched.
   * S3 driver (LOG_STORAGE_DRIVER=s3, optimization-notes 2.6): one gzip
   * object per execution; the DB keeps only the object reference, and any
   * upload failure falls back to DB rows so the log viewer keeps working.
   * NOTE (kept as-is by design): the S3 path spans two stores (object
   * storage + Postgres rows/pointer) and cannot share one transaction —
   * cross-storage consistency is out of scope here. The failure window is
   * bounded and benign: S3-put-then-DB-delete means the exec row already
   * points at the fresh object (viewers read S3, stale DB rows are inert);
   * the reverse order would risk a dangling pointer, hence delete-after-put.
   * R4-P1: append=true extends the existing store instead of replacing it —
   * backfill calls this once per page and a replace per page would leave
   * only the last page behind for any log longer than one page.
   */
  private async storeLogLines(
    executionId: string,
    logs: string | string[],
    startLineNumber = 0,
    opts: { append?: boolean } = {},
  ): Promise<void> {
    const lines = typeof logs === "string" ? logs.split("\n") : logs;
    const append = opts.append === true;
    const s3 = this.resolveS3Storage();
    // BUG-06 修复：S3 失败回退时的内容并集与指针收回。
    // existing 在 try 外声明——append 模式在 put 前读取的既有内容是回退
    // 路径唯一能拿到的"此前页面"，put 失败后必须并入 DB 回退，否则：
    // - append：本页落 DB 成孤儿行（exec 行仍指 S3，S3 优先读取面永远
    //   看不到它们）；
    // - replace：旧 DB 行 + 旧 S3 对象都在，事务重写 DB 后指针仍指旧
    //   对象，读取面永远看到 STALE 内容。
    // 两种场景都在回退事务成功后把 exec 行指针收回 db，使 DB 恢复自洽；
    // 残留的旧 S3 对象成为惰性垃圾（键按 executionId 确定性复用，后续
    // 一次成功的 storeLogLines 会覆盖它），跨存储一致性边界见方法头注。
    let existing: string | null = null;
    let s3Failed = false;
    if (s3) {
      try {
        let content = lines.join("\n");
        if (append) {
          existing = await this.s3GetExistingLog(s3, executionId);
          if (existing !== null && existing.length > 0) {
            content = `${existing}\n${content}`;
          }
        }
        const key = await s3.put(executionId, content);
        if (!append) {
          await this.logLineRepo.delete({ executionId });
        }
        await this.execRepo.update(executionId, {
          logStorage: "s3",
          logObjectKey: key,
        });
        return;
      } catch (err: unknown) {
        s3Failed = true;
        this.logger.warn(
          `S3 log upload failed for execution ${executionId} (${err instanceof Error ? err.message : String(err)}) — falling back to DB log lines`,
        );
      }
    }
    // append 回退且此前内容在 S3：全量改写（existing + 本页），行号归零
    const mergeExisting = append && s3Failed && existing !== null;
    const fallbackLines =
      mergeExisting && existing !== null
        ? [...existing.split("\n"), ...lines]
        : lines;
    const fallbackReplace = !append || mergeExisting;
    const fallbackStart = mergeExisting ? 0 : startLineNumber;
    const entities = fallbackLines.map((content, i) =>
      this.logLineRepo.create({
        executionId,
        lineNumber: fallbackStart + i,
        content,
        // OBS-03: 每行推断级别落库（levelOfLine 纯文本推断——执行器侧
        // stdout/stderr 已合流，回调不带流来源，无更强信号可用）；
        // 推断不到为 null = 未知级别，level 过滤查询不返回。
        level: levelOfLine(content),
      }),
    );
    const CHUNK = 500;
    await this.dataSource.transaction(async (manager) => {
      if (fallbackReplace) {
        await manager.delete(ExecutionLogLine, { executionId });
      }
      for (let i = 0; i < entities.length; i += CHUNK) {
        await manager.save(ExecutionLogLine, entities.slice(i, i + CHUNK));
      }
    });
    if (s3Failed) {
      // 事务成功后收回指针（顺序不可换：先改指针再写行会闪出"无行可读"窗口）
      await this.execRepo.update(executionId, {
        logStorage: "db",
        logObjectKey: null,
      });
    }
  }

  /**
   * RT-LOG: 执行行的 executorAddress 查询——回调鉴权的 per-executor HMAC 兜底
   * 需要它（N26 形态），但仓储本身不对外暴露（收口在 service 内）。
   * 返回 null 表示执行行不存在。
   */
  async findExecutionAddress(executionId: string): Promise<string | null> {
    const exec = await this.execRepo.findOne({
      where: { id: executionId },
      select: { id: true, executorAddress: true },
    });
    return exec?.executorAddress ?? null;
  }

  /**
   * RT-LOG: Append a real-time chunk of log lines from an actively running execution.
   * Persists into ExecutionLogLine so streamExecutionLogs pushes them immediately via SSE.
   * Idempotent per (executionId, lineNumber).
   */
  async appendLogChunk(
    executionId: string,
    fromLine: number,
    lines: string[],
  ): Promise<{ count: number }> {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { count: 0 };
    }
    const exec = await this.execRepo.findOne({
      where: { id: executionId },
      select: { id: true, status: true },
    });
    if (!exec) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId,
      });
    }

    const entities = lines.map((content, i) =>
      this.logLineRepo.create({
        executionId,
        lineNumber: fromLine + i,
        content,
        level: levelOfLine(content),
      }),
    );

    const CHUNK = 500;
    await this.dataSource.transaction(async (manager) => {
      // Idempotency: delete only the exact range [fromLine, fromLine + lines.length) to avoid overwriting later chunks
      const toLine = fromLine + lines.length;
      await manager.delete(ExecutionLogLine, {
        executionId,
        lineNumber: Between(fromLine, toLine - 1),
      });
      for (let i = 0; i < entities.length; i += CHUNK) {
        await manager.save(ExecutionLogLine, entities.slice(i, i + CHUNK));
      }
    });

    return { count: lines.length };
  }

  /**
   * Fetch the current S3 log object for an execution, or null when it does
   * not exist yet (first append page) / cannot be read. Used by the append
   * path of storeLogLines to concatenate multi-page backfills.
   */
  private async s3GetExistingLog(
    s3: S3LogStorage,
    executionId: string,
  ): Promise<string | null> {
    try {
      return await s3.get(s3.objectKey(executionId));
    } catch (err: unknown) {
      // 巡查·静默吞错收口：这里同时承接「对象不存在（首页 append，正常）」
      // 与「S3 故障 / 超过 MAX_LOG_BYTES（异常）」两类结局，此前 bare catch
      // 一律 null——后者会把 BUG-06 内容并集的 existing 静默置空，fallback
      // 落库的日志从此缺前几页且日志面零痕迹。best-effort 保留 null 语义
      // （不炸主链），但异常必须可见：warn 一次（外层 put 失败时还会再 warn
      // 一次回退原因，两行日志共同定位存储侧故障）。
      this.logger.warn(
        `S3 existing log read failed for execution ${executionId} (${err instanceof Error ? err.message : String(err)}) — append fallback may lose prior pages`,
      );
      return null;
    }
  }

  /** Lazily resolve the optional S3 log backend from config. */
  private resolveS3Storage(): S3LogStorage | null {
    if (!this.s3StorageResolved) {
      this.s3LogStorage = S3LogStorage.fromConfig(this.configService);
      this.s3StorageResolved = true;
    }
    return this.s3LogStorage;
  }

  /**
   * Fetch full logs from the executor (backed by its local log files) via
   * GET /api/logs/{executionId} and persist them as ExecutionLogLine rows.
   * Returns true on success; any failure is non-fatal (returns false).
   */
  private async backfillFullLogsFromExecutor(
    execution: TaskExecution,
    executorAddress: string,
  ): Promise<boolean> {
    if (!executorAddress) return false;
    try {
      // DB-first via ExecutorService so rotation propagates to log backfill
      // too — a raw env read would be rejected by the executor's own
      // DB-first verification (same consistency rule as push/dispatch).
      const token = await this.executorService.getSharedToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const { default: axios } = await import("axios");
      const url = this.executorService.getExecutorUrl(
        executorAddress,
        `api/logs/${execution.id}`,
      );
      // SEC-SSRF-01：本处此前是执行器调用面里**唯一**漏掉 SSRF 守卫的
      // axios 出站（executor.service.ts dispatch/broadcast、controller
      // reload-config、app-deployment 两处、executor-package 均已守卫）。
      // executorAddress 来自执行器自报的 register/heartbeat 字段，未做归一；
      // 且本方法由执行器自己的终态回调触发（handleCallback → winnerAddress），
      // 因此远端执行器可令 admin-api 带着共享 token 去请求
      // 169.254.169.254（云元数据）等内部地址，并把响应体当作日志行持久化后
      // 展示给用户——是可读出的外泄原语，而非仅盲 SSRF。
      // F-3 (SEC-NEW): validate + pin to the validated IP (Host/SNI kept).
      const pinned = await assertAndPinExecutorUrl(url);
      const pinCfg = pinnedAxiosConfig(pinned);
      // High-6.3: hard cap on what a single executor response may carry
      // (Node executor previously could return the entire log in one chunk —
      // we now refuse anything above 64 MB to protect admin-api memory).
      const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
      const PAGE_LIMIT = 2000;
      // rt-2 残差（第 3 轮 runtime-perf，止血轮不改分页逻辑）：页数有帽
      // （200 页 = 40 万行），但**累计字节数无帽**——单页 64MB × 200 页，
      // 累计读回/拼接/压缩预算无上界；且 S3 写面 put() 不校验 MAX_LOG_BYTES，
      // 超过 100MB 的对象会写成一个读取面（getStream 的 cap）拒读的「黑洞
      // 对象」，只能靠下一次成功写入覆盖。真正的解是 rt-2 结构性另一半
      // （每页独立对象 + manifest），不在本轮范围。
      const MAX_PAGES = 200; // 400k-line backfill ceiling
      let fromLine = 0;
      let totalPersisted = 0;
      // rt-2 残差（字节帽）：页数有帽（200×2000 行）但**累计字节数**此前无帽，
      // 单页 64MB × 200 页可以写出超过 MAX_LOG_BYTES 的对象——读取面（getStream
      // 的 100MB cap）会拒读，形成只能靠下一次成功写入覆盖的「黑洞对象」。
      // 这里在累计超帽时停止背填并 warn：宁可少背一段可诊断的日志，不写入
      // 一个读不出来的对象。O(P²) 的读回/重压仍在（异步 gzip 已止血同步阻塞），
      // 结构性解法（每页独立对象 + manifest）留待后续。
      let totalBytes = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const resp = await axios.get(url, {
          headers,
          timeout: 10_000,
          maxContentLength: MAX_DOWNLOAD_BYTES,
          maxBodyLength: MAX_DOWNLOAD_BYTES,
          params: { fromLine, limit: PAGE_LIMIT },
          ...pinCfg,
        });
        const chunk: string[] = Array.isArray(resp.data?.lines)
          ? resp.data.lines.filter((l: unknown) => typeof l === "string")
          : [];
        if (chunk.length === 0) break;
        // Persist each page as it arrives — never accumulate the entire log
        // in memory. R4-P1: page 0 replaces any stale rows; later pages must
        // APPEND (storeLogLines' replace semantics would delete the previous
        // pages, leaving only the final page for any log > PAGE_LIMIT lines).
        // storeLogLines re-numbers lineNumber to start at the global offset
        // so the DB row numbers reflect absolute positions.
        await this.storeLogLines(execution.id, chunk, fromLine, {
          append: page > 0,
        });
        totalPersisted += chunk.length;
        fromLine += chunk.length;
        totalBytes += chunk.reduce(
          (n, line) => n + Buffer.byteLength(line, "utf8") + 1,
          0,
        );
        if (totalBytes > MAX_LOG_BYTES) {
          this.logger.warn(
            `Backfill for execution ${execution.id} exceeded MAX_LOG_BYTES ` +
              `(${MAX_LOG_BYTES}); stopping at ${totalPersisted} line(s) instead of ` +
              `writing an object the read path refuses (rt-2)`,
          );
          break;
        }
        const total: unknown = resp.data?.totalLines;
        if (typeof total !== "number" || total <= 0 || fromLine >= total) {
          break;
        }
      }
      if (totalPersisted === 0) return false;
      this.logger.log(
        `Backfilled ${totalPersisted} full log lines for execution ${execution.id}`,
      );
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to backfill full logs for execution ${execution.id} from ${executorAddress}: ${message} — keeping truncated callback logs`,
      );
      return false;
    }
  }

  /**
   * ARCH-21：终态落库（唯一 winner）之后发布领域事件，副作用与主链解耦。
   *
   * - SUCCESS → execution.completed；FAILED/TIMEOUT → execution.failed。
   *   迁移前的「改动1」失败告警（notifyCallbackFailure 直调）现由
   *   notification 模块 ExecutionEventsListener 订阅 execution.failed 复刻
   *   同款语义（含 taskRepo 回查告警配置与 NOTIFICATION_FAILED 审计兜底）。
   * - emit 时机 = 迁移前通知直调的时机（fan-out/日志持久化之前）：即便后续
   *   步骤抛错被 catch 成 success:false（执行器会重试整批），事件也已派发
   *   一次；重试回调走 affected=0 分支不再 emit——「每个失败执行一次告警」
   *   的旧不变量原样保持。
   * - fail-open：总线对监听器抛错只记日志（同步/异步都吞），绝不影响主链
   *   结果（测试断言）；payload 带全监听器所需 id 级信息，实体配置由监听器
   *   自行回查——common 层不反向依赖 task 实体（见 domain-events.ts）。
   * - eventBus 为 null（@Optional 兜底）时静默跳过：主链行为与迁移前一致，
   *   仅事件不发（既有旧单测装配兼容，先例 OBS-04 reportRepo）。
   */
  /**
   * BUG-21（由 nginx SSE 真机验证暴露）：**派发失败**终态的领域事件发布出口。
   *
   * 背景：execution.completed/failed 一直只由回调路径（handleCallback）发布。
   * 派发阶段就失败的执行（执行器离线 / 无匹配执行器 / 派发超时——即 executor
   * 根本没接单的场景）在 processor 里直接写终态 + 直调通知，**从不发领域
   * 事件**，导致三类消费者全部漏掉这类失败：
   *   - `GET /api/executions/stream`（Dashboard 终态加速流）
   *   - FEAT-07 出站 webhook（event_subscriptions 订阅 execution.failed）
   *   - ARCH-21 的 notification 订阅者（processor 的直调绕过了统一语义）
   *
   * 现在 processor 在**终态落库成功后**调用本方法，通知改由订阅者统一发出
   * （顺带修掉直调版本 taskId 传 undefined 的字段缺失）。payload 构造复用
   * emitTerminalEvent，避免两处实现漂移。
   *
   * 幂等边界：只在「最后一次尝试 + 终态落库成功」时调用（processor 侧把关）；
   * 与回调路径不会双发——派发失败的执行不可能再收到回调。
   */
  publishTerminalEventForDispatch(
    execution: TaskExecution,
    cb: { errorMessage?: string; logs?: string },
  ): void {
    const finishedAt = execution.endTime ?? new Date();
    const durationMs =
      execution.duration ??
      (execution.startTime
        ? finishedAt.getTime() - execution.startTime.getTime()
        : null);
    this.emitTerminalEvent(
      execution,
      execution.status,
      execution.failureReason ?? null,
      cb,
      durationMs,
      finishedAt,
    );
  }

  /**
   * FIX-4.2: 执行终态唤醒的发布入口（webhook wait 事件化，见
   * execution-wake.service.ts）。调用方契约：**终态已落库后**调用——唤醒即
   * 意味着等待方复查 DB 一定可见终态。@Optional 装配缺席时 no-op；任何异常
   * 吞掉（旁路增强，绝不影响主链——webhook 侧退避轮询兜底仍在）。
   */
  publishExecutionWake(executionId: string): void {
    try {
      this.executionWakeService?.publishTerminal(executionId);
    } catch {
      /* best-effort：唤醒失败由轮询兜底 */
    }
  }

  /**
   * FIX-3.1（timeout-policy.util ②「超时预警」的运行期消费点）：按
   * elapsed ≥ timeout×ratio 判定并发送一次 WARNING 预警
   * （NotificationService.notifyTimeout；A-11 起透传任务级 alarmChannels，
   * 与失败告警 notifyFailureWithConfig 同源路由）。
   *
   * 「每执行至多一次」由 Redis SETNX 闸保证（acquireLock 即 SET NX PX，
   * key = acf:timeout-warn:{executionId}，TTL 24h 远大于任何执行生命周期、
   * 锁不释放即去重窗口；renew:false——watchdog 会把一次性窗口续成永久锁，
   * 参见 redis-lock.service High-5.1 注）。闸先行：未拿到闸的调用零额外
   * 查询直接返回；Redis 不可用时预警静默跳过（旁路，无新失败面）。
   *
   * ARCH-21 红线的**显式例外**（与构造器注记同源）：本方法是
   * NotificationService 在本文件的唯一调用点，fire-and-forget、任何失败
   * 吞掉、不进入任何终态写路径——「终态事件 → 通知」主链仍走事件总线。
   */
  private async maybeNotifyTimeoutWarning(
    exec: TaskExecution,
    task: Task,
  ): Promise<void> {
    const lockService = this.redisLockService;
    const notifyService = this.notificationService;
    if (!lockService || !notifyService) return;
    if (!exec.startTime) return;
    const elapsedMs = Date.now() - new Date(exec.startTime).getTime();
    const thresholdMs = timeoutWarnThresholdMs(
      task.timeout,
      task.timeoutWarnRatio,
      elapsedMs,
    );
    // null = 未启用预警（ratio 缺失/非法）或未达阈值——下次观察点再判。
    if (thresholdMs === null) return;
    let lock: { release: () => Promise<boolean> } | null = null;
    try {
      lock = await lockService.acquireLock(
        `acf:timeout-warn:${exec.id}`,
        TaskService.TIMEOUT_WARN_LOCK_TTL_MS,
        { renew: false },
      );
    } catch {
      return;
    }
    if (!lock) return; // 已有实例为该执行发过预警
    try {
      await notifyService.notifyTimeout(
        task.name,
        exec.id,
        Math.round(thresholdMs / 1000),
        task.id,
        // NETOPT-5①: applicationId 透传（scope=application 静默判定同源）。
        task.applicationId ?? undefined,
        // A-11: 超时预警与失败告警同源渠道路由——透传 task.alarmChannels
        // （notifyFailureWithConfig 同款入口）；空/缺省回落全渠道（原行为）。
        task.alarmChannels ?? undefined,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `FIX-3.1: timeout warn notification failed for execution ${exec.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * FIX-7.1: 终态回调失败/超时分支的自动 AI 分析（脚本阶段失败）。
   *
   * - 输入与 analyzeExecution 同源：净化日志 + 平台已判定的 failureReason /
   *   exitCode + 任务级 runbook（FIX-6.2 的结构化上下文，AI 结论与运维沉淀
   *   对齐）；task 行不可得（无 taskId / 已删除）时跳过分析返回 ""。
   * - fail-open 双保险：AiAnalysisService.analyzeFailure 内部永不抛错
   *   （ARCH-30 契约），这里的 try/catch 兜住其外的任何意外——分析的任何
   *   失败都只跳过分析，绝不阻塞终态落库（调用点在 transitionToTerminal 前）。
   */
  private async autoAnalyzeCallbackFailure(
    task: Task | null,
    cb: { logs?: string; exitCode?: number },
    failureReason: ExecutionFailureReason,
  ): Promise<string> {
    if (!task) return "";
    try {
      return await this.aiAnalysisService.analyzeFailure(
        { name: task.name, runtime: task.runtime },
        cb.logs ?? "",
        {
          failureReason,
          exitCode: typeof cb.exitCode === "number" ? cb.exitCode : null,
          runbook: task.runbook ?? null,
        },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `FIX-7.1: auto analysis skipped (terminal state unaffected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "";
    }
  }

  private emitTerminalEvent(
    execution: TaskExecution,
    status: ExecutionStatus,
    failureReason: ExecutionFailureReason | null,
    cb: { errorMessage?: string; logs?: string },
    durationMs: number | null,
    finishedAt: Date,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutionTerminalEventPayload = {
      executionId: execution.id,
      taskId: execution.taskId ?? null,
      taskName: execution.taskName ?? execution.taskId,
      // ExecutionStatus 枚举值即小写字面量（"success"/"failed"/"timeout"），
      // 载荷类型以字面量联合表达——common 层不 import task 实体（见上注）。
      status: status as ExecutionTerminalEventPayload["status"],
      failureReason: failureReason ?? null,
      errorMessage: cb.errorMessage,
      // rt-3：只带**首行摘要**（硬切 500，与 listener 的 errorSummary 同常量
      // EXECUTION_SUMMARY_MAX_CHARS），不再携带回调原始 logs。事件会被逐副本
      // PUBLISH 到 Redis、并被每条 SSE 连接各自再 JSON.stringify 一遍，而唯一
      // 消费方只取首行做告警回退——全文留在数据面（DB logs 列 / S3 对象），
      // 需要全文的消费方走 GET .../executions/:execId/logs 一次性拉取。
      logHead: logHeadOf(cb.logs),
      aiAnalysis: execution.aiAnalysis ?? null,
      durationMs,
      finishedAt: finishedAt.toISOString(),
    };
    // 总线自身契约即 fail-open（emit 永不外抛）；此 try/catch 是第二道保险丝，
    // 保证「发布事件」这一新增步骤在任何意外实现下也绝不改变主链结果。
    try {
      this.eventBus.emit(
        status === ExecutionStatus.SUCCESS
          ? DOMAIN_EVENTS.EXECUTION_COMPLETED
          : DOMAIN_EVENTS.EXECUTION_FAILED,
        payload,
      );
    } catch {
      /* never reached with DomainEventBus's fail-open contract */
    }
  }

  /**
   * 改动3：重复回调日志补写闭环。
   *
   * 背景：winner 分支的日志持久化在终态 UPDATE 之后——若 storeLogLines 抛错，
   * item 返回 success:false → 执行器重试整批 → 重试落入 affected=0 分支并在此
   * 提前返回，跳过日志持久化 → 该执行日志永久丢失。
   *
   * 因此在 affected=0 分支：当回调带 logs 且该 execution 的 logStorage /
   * logObjectKey 仍为空（说明上一次 winner 未成功写入日志）时，补做一次持久化
   * 再返回。无需区分是否 winner——storeLogLines 的 replace 语义本身幂等；持久化
   * 失败仅 logger.warn，不改变重复回调既有的 success:true 幂等语义。
   */
  private async persistCallbackLogsIfMissing(
    execution: TaskExecution,
    cb: {
      executionId: string;
      logs?: string;
      executorAddress?: string;
    },
  ): Promise<void> {
    const logStoreMissing = !execution.logStorage && !execution.logObjectKey;
    if (!cb.logs || !logStoreMissing) return;
    try {
      let stored = false;
      if (LOG_TRUNCATION_MARKER.test(cb.logs)) {
        stored = await this.backfillFullLogsFromExecutor(
          execution,
          execution.executorAddress || cb.executorAddress || "",
        );
      }
      if (!stored) {
        // RT-LOG: 若本次执行已经通过实时流落了行，回调里的**截断**日志
        // （执行器内存里只留了头尾）会把完整流式日志整体覆盖掉——用户看到
        // 的日志反而比执行中更少（storeLogLines 的 replace 语义先 delete
        // 再写，正是覆盖点）。故「已有落库行 且 回调日志截断」时跳过写入，
        // 保留实时流的成果；其余情形（无既有行、或回调日志是未截断的全量）
        // 一律照常写入，既有语义不变。
        //
        // 判据取「已落行数」而非「有无 S3 指针」：S3 回填失败（stored=false）
        // 时既有行就是实时流的全部成果，同样不能丢。
        const keepStreamed =
          LOG_TRUNCATION_MARKER.test(cb.logs) &&
          (await this.hasStreamedLogLines(cb.executionId));
        if (!keepStreamed) {
          await this.storeLogLines(cb.executionId, cb.logs);
        }
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to backfill missing logs for execution ${cb.executionId} on duplicate callback (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /**
   * RT-LOG: 该执行是否已有落库日志行。
   *
   * 只用于「回调日志是截断形态时是否允许覆盖既有行」这一个判定——非截断
   * 回调日志仍照常走 storeLogLines 的 replace 语义（它是权威全量）。
   */
  private async hasStreamedLogLines(executionId: string): Promise<boolean> {
    return (await this.logLineRepo.count({ where: { executionId } })) > 0;
  }

  /**
   * 改动5：kill 命中后，best-effort 通知执行器真正终止进程。
   *
   * 地址来源为库中实际值（RETURNING 结果，快照作兜底）；拿不到地址则跳过。
   * 任何失败（离线 / 超时 / 404 / 网络错）一律吞掉并 logger.warn，绝不影响
   * kill 的结果返回——执行器侧 /kill 返回 200=已终止或已结束、404=不在运行，
   * 均无需回传给管理员。
   *
   * P2: HTTP 实现收敛至 ExecutorService.notifyExecutorKill（scheduler stale
   * sweep re-enqueue 前的 kill 通知共用，避免两份逻辑）。本包装保留调用点
   * 契约：空地址跳过、异常兜底吞掉。
   *
   * P2-3（2026-10-26 第三轮审计）：透传执行行的 executorId（行身份）——pull
   * 同址多行时 kill 必须按行寻路（进别行命令队列 = 静默 miss，而这是 stale
   * sweep 防双跑的关键防线）。存量行（迁移 0055 前派发）executorId 为空，
   * 上层回落 address 寻路 + warn，行为与引入前一致。
   */
  private async notifyExecutorKill(
    executionId: string,
    executorAddress?: string | null,
    executorId?: string | null,
  ): Promise<void> {
    if (!executorAddress) return;
    try {
      await this.executorService.notifyExecutorKill(
        executionId,
        executorAddress,
        executorId,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to notify executor ${executorAddress} to kill execution ${executionId}: ${message}`,
      );
    }
  }

  /**
   * ARTIFACTS-INDEX-46（部署模型评审 §4.6）：终态回调产物清单的关系化同步
   * （execution_artifacts 表写侧，与 task_executions.artifacts jsonb 双轨）。
   *
   * ## 整替语义（幂等 upsert）
   *
   * 回调可能重报清单（执行器重试整批、清单随后补齐），唯一键 (executionId,
   * name) 下「逐条 upsert」会让**上次有、这次没有**的产物残留成幽灵行——与
   * jsonb 侧「整列覆盖」语义不一致。故这里按执行整替：先 delete 该执行全部
   * 索引行、再 insert 本批清单。winner 语义（transitionToTerminal affected=1
   * 才走到这里）保证同一执行至多整替一次；重复回调走 affected=0 分支不会重放。
   *
   * ## applicationId 快照
   *
   * 冗余自任务行 tasks.applicationId（**写时快照**，非 FK 联动）：任务删除后
   * 执行行级联消失（taskId CASCADE），索引行随执行行走；应用删除后 FK SET
   * NULL 保留历史行（见迁移 1790000000065 头注）。任务查不到（已删的极端
   * 竞态）→ null——按应用查不到它，但按任务/执行维度仍完整。
   *
   * ARTIFACTS-INDEX-47（服务层质量巡查·事务边界）：delete+insert 必须在
   * **同一事务**内。winner 语义（transitionToTerminal affected=1 才走到这里）
   * 保证同一执行**至多整替一次**——重复回调 affected=0 直接 continue，执行
   * 已终态化后不会有「下一次上报」补写。若两步写无事务：delete 成功、insert
   * 失败（连接抖动/约束冲突）时该执行的索引行被清空且**永久丢失**（jsonb
   * 主轨仍在，GET /artifacts 对该执行从此恒空，直到 90d retention 级联删）。
   * 包进事务后 best-effort 的前提才真正成立：失败 = 整体没写（原子），
   * 调用点 warn 不炸主链的语义不变。
   *
   * @private 仅由 handleCallback winner 分支调用（调用点已做 best-effort 包裹）。
   */
  private async syncArtifactIndexRows(
    executionId: string,
    taskId: string,
    artifacts: Array<{ name: string; size: number; sha256: string }>,
  ): Promise<void> {
    if (!this.artifactIndexRepo) return;
    // applicationId 快照：任务行可能已删（执行行尚在的窗口极窄，但仍要防御）。
    let applicationId: string | null = null;
    if (taskId) {
      const taskRow = await this.taskRepo.findOne({
        where: { id: taskId },
        select: ["applicationId"] as never,
      });
      applicationId = taskRow?.applicationId ?? null;
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ExecutionArtifactRow, { executionId });
      if (artifacts.length === 0) return;
      const rows = artifacts.map((a) =>
        this.artifactIndexRepo!.create({
          executionId,
          taskId,
          applicationId,
          name: a.name,
          size: a.size,
          sha256: a.sha256,
        }),
      );
      await manager.insert(ExecutionArtifactRow, rows);
    });
  }

  async handleCallback(
    callbacks: Array<{
      executionId: string;
      status: "success" | "failed";
      exitCode?: number;
      logs?: string;
      errorMessage?: string;
      failureReason?: ExecutionFailureReason;
      durationMs?: number;
      executorAddress?: string;
      /**
       * ADR-017 阶段 3（协议 v6）：执行器自报的稳定安装身份（64 位小写十六
       * 进制）——回调面的**行身份**输入，由控制器解析为行 id 后经
       * `fingerprintExecutorIdByAddress` 传入。缺省（旧执行器/采集失败/SDK
       * 调用方）→ 该级不参与，行为与引入前一致。
       */
      deviceFingerprint?: string;
      /** FEAT-05: 执行产物清单（可选，best-effort，随终态回调上报）。 */
      artifacts?: Array<{ name: string; size: number; sha256: string }>;
      /**
       * python_task_multiversion: 执行器上报的结构化留痕（可选）。
       * 当前承载解释器快照 `{requested, resolved, reason, detail, pool}`，
       * 落库到 `task_executions.result`。旧执行器不发送该字段。
       */
      result?: Record<string, unknown>;
    }>,
    /**
     * ADR-017 阶段 3（复查补口）：地址 → **所持凭据所属行 id** 的映射，由
     * 控制器在令牌校验时推导（`resolveCredentialExecutorId`）。**刻意是独立
     * 参数而非 callback item 字段**：它是服务端推导的事实，若放进回调体就
     * 变成调用方自报——等于把不可伪造的行身份判据交给伪造方。
     *
     * 缺省（未传 / 该地址无匹配行）→ 行身份判据不参与，回落地址相等判据，
     * 行为与引入前逐字节一致。test 与内部调用方不传即零变化。
     */
    credentialExecutorIdByAddress?: Map<string, string | null>,
    /**
     * ADR-017 阶段 3（协议 v6，方案 C）：executionId → **回调自报指纹解析出的
     * 行 id**。
     *
     * 行身份三级阶梯的**第一级**（见 ExecutionCallbackController 注释）。为什么
     * 它比凭据归属行更强：共享令牌不绑定任何行，故第二级在「共享令牌 + 同址
     * 多行」下拿不到行身份——正是本方案要补的缺口。指纹由 v6 执行器上报，
     * 服务端已查库校验其对应行存在（`resolveExecutorIdByFingerprint`）。
     *
     * **按 executionId 分键而非 address**：同批次里可以有两个同址但不同行的
     * 执行（ADR-017 §5），各自上报自己的指纹；按 address 分键会把第二条
     * 判到第一条的行走上，误拒合法回调。
     */
    fingerprintExecutorIdByExecution?: Map<string, string | null>,
  ) {
    const results = [];
    // F-11（本轮审计）: 批量回调 N+1 消除。关键判据：N+1 问题只存在于
    // `callbacks.length >= 2`——单条回调时 findOne 本身就是最优单查询（1 次
    // 往返），保持原路径（行为逐字节不变）；多条回调才升级为一次
    // `find({ where: { id: In(ids) } })` 批量查出后建 Map（100 条 → 1 条查询，
    // 且 Map 天然去重——同一 executionId 重复回调只查一次）。
    // 单条回调的处理语义不变：查不到 execution 仍走各自的结果分类计数
    //（not_found），不影响其他条目。
    let executionById: Map<string, TaskExecution> | null = null;
    if (callbacks.length > 1) {
      executionById = new Map(
        (
          await this.execRepo.find({
            where: { id: In(callbacks.map((cb) => cb.executionId)) },
          })
        ).map((execution) => [execution.id, execution]),
      );
    }
    // NETOPT-1⑥: 循环内逐条 taskRepo.findOne（广播判定 + CORE-04 超时动作）
    // 升级为一次 In() 批查建 Map——多条回调 × 2 个查点最坏 2N 条查询收敛为
    // 1 条（对齐上方 executionById 的 F-11 模式）。单条回调保持原逐条查
    // （1 次往返即最优，行为逐字节不变）。与原 findOne 同不带 withDeleted，
    // 软删除语义一致。
    let taskById: Map<string, Task> | null = null;
    if (executionById) {
      const taskIds = [
        ...new Set(
          [...executionById.values()]
            .map((e) => e.taskId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      taskById = new Map(
        taskIds.length > 0
          ? (await this.taskRepo.find({ where: { id: In(taskIds) } })).map(
              (t) => [t.id, t],
            )
          : [],
      );
    }
    for (const cb of callbacks) {
      try {
        const execution = executionById
          ? executionById.get(cb.executionId)
          : await this.execRepo.findOne({ where: { id: cb.executionId } });
        if (!execution) {
          // 可观测性补齐：callback 业务结果分类计数（not_found）
          recordRuntime("autoflow_callback_business_total", {
            result: "not_found",
          });
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Execution not found",
          });
          continue;
        }

        // R-16（DEEP_REVIEW 0ef3bbe）：派发落库前窗口守卫——execution 处于
        // PENDING 且 executorAddress 为 null（尚未派发）时拒绝终态回调。
        // 此前任何持有效执行器凭据者可对未派发 execution 回报任意终态
        // （success/failed），导致状态被篡改。RUNNING 但快照 executorAddress
        // 为 null 属 dispatch 落库窗口的合法场景（RETURNING 会取库中实际地址），
        // 不在此拒绝。
        //
        // B-7（调度域审计）：守卫扩展到 WAITING。WAITING（互斥/部署约束
        // 排队）从未派发——executorAddress 恒为 null，却同属打开态：旧守卫
        // 只挡 PENDING，持共享执行器凭据者可把**别家排队中**的执行写成终态
        // （排队执行凭空"成功/失败"，唤醒后又被 dispatch 二次覆盖）。终态
        // 回调只可能来自真实派发，而派发必先经 processor claim（WAITING→
        // RUNNING）——WAITING 行不存在合法的终态回调来源；人工终止/覆盖走
        // killExecution / COVER_EARLY（transitionToTerminal 直写，不经本
        // HTTP 回调面）。
        //
        // 超时耦合注记（N-17）：这个「executorAddress 合法为 null」的窗口由
        // 派发 HTTP 的客户端超时上界约束——executor.service.dispatch（及
        // dispatchBroadcast）对执行器 accept 请求的超时为
        // `((task.timeout || 300) + 10) * 1000` ms，即窗口长度与 task.timeout
        // 成比例。正因长超时任务的派发窗口可以很长（HTTP 还没返回、executor
        // 却可能已接单开跑），本守卫只拒「确实尚未派发」的 PENDING/WAITING、
        // 放行 RUNNING+null——两者以「是否已开始执行」划界，而不是以地址是否
        // 已落库划界。
        if (
          (execution.status === ExecutionStatus.PENDING ||
            execution.status === ExecutionStatus.WAITING) &&
          !execution.executorAddress
        ) {
          recordRuntime("autoflow_callback_business_total", {
            result: "not_dispatched",
          });
          this.logger.warn(
            `R-16/B-7: Rejected terminal callback for execution ${cb.executionId} ` +
              `in status ${execution.status} which has not been dispatched yet (executorAddress is null).`,
          );
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Execution has not been dispatched yet",
          });
          continue;
        }

        // P1: once an execution has been dispatched to a specific executor,
        // callbacks must come from that address — a missing or different
        // address is rejected (both executor runtimes always send it).
        //
        // ADR-017 阶段 3（复查补口）：**行身份优先**。阶段 3 把
        // `uq_executors_address` 收窄为 partial（仅 push 行），pull 模式允许
        // **同地址多行并存**（ADR-017 §5）——此时「地址相等」不再是「同一台
        // 机器」的证明：两台自报同一地址时本闸恒等，拦不住串台（迁移
        // 1790000000055 的类注释已把这条列为待修面之一）。
        //
        // 修法用**行身份三级阶梯**（优先级从高到低）：
        //   ① 回调自报指纹解析出的行（协议 v6；**独立于令牌类型**，故共享
        //      令牌路径也能拿到行身份——这正是方案 C 要补的缺口）；
        //   ② 调用方所持凭据所属行（per-executor 令牌专有；由控制器服务端
        //      推导后作为独立参数传入）；
        //   ③ 地址相等（唯一行时的 legacy 兜底）。
        // 三级都拿不到行身份 → 只走 ③，行为与引入前逐字节一致。
        //
        // 判据语义：拿到行身份后，要求 `row === execution.executorId`——即
        // 「你自称/自证的那一行，必须就是 dispatcher 派发的那一行」。不一致
        // 即拒（跨行申领别人那行的执行）。执行行无 `executorId`（存量行）时
        // 无从比对，回落 ③。
        const fingerprintRowId =
          fingerprintExecutorIdByExecution?.get(cb.executionId) ?? null;
        const credentialRowId = cb.executorAddress
          ? (credentialExecutorIdByAddress?.get(cb.executorAddress.trim()) ??
            null)
          : null;
        const claimedRowId = fingerprintRowId ?? credentialRowId;
        const claimedBy = fingerprintRowId
          ? "deviceFingerprint"
          : credentialRowId
            ? "per-executor credential"
            : null;
        if (
          execution.executorId &&
          claimedRowId &&
          claimedRowId !== execution.executorId
        ) {
          recordRuntime("autoflow_callback_business_total", {
            result: "executor_identity_mismatch",
          });
          this.logger.warn(
            `ADR-017: Rejected terminal callback for execution ${cb.executionId} — ` +
              `the callback identifies executor row ${claimedRowId} (via ${claimedBy}), ` +
              `but the execution was dispatched to row ${execution.executorId} ` +
              `(address ${execution.executorAddress ?? "-"}).`,
          );
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Executor identity mismatch",
          });
          continue;
        }
        if (
          execution.executorAddress &&
          cb.executorAddress !== execution.executorAddress
        ) {
          // 可观测性补齐：地址不符与缺地址分别归类计数
          recordRuntime("autoflow_callback_business_total", {
            result: cb.executorAddress
              ? "address_mismatch"
              : "address_mismatch_missing_address",
          });
          results.push({
            executionId: cb.executionId,
            success: false,
            error: cb.executorAddress
              ? "Executor address mismatch"
              : "executorAddress is required for this execution",
          });
          continue;
        }

        // R-06（DEEP_REVIEW 0ef3bbe）: 广播执行的槽位释放。广播 dispatch 对
        // 每个目标执行器 runningTaskCount +1（executor.service.dispatchBroadcast），
        // 但广播执行的 executorAddress 恒为 null（task.processor 仅非广播落库），
        // 下方 winner 分支的 releaseExecutorSlot(winnerAddress) 对 null 早退 no-op。
        // 这里按任务 executeMode 权威判定广播，随后无论本回调是 winner 还是重复回调
        // （affected=0），都按 cb.executorAddress 释放该执行器自己的那一个坑——
        // N 个被接受执行器各回调一次，恰好 -N。非广播执行不走此分支，单播释放
        // 语义（winner-once）不变。
        let isBroadcast = false;
        if (!execution.executorAddress && execution.taskId) {
          // NETOPT-1⑥: 批量路径查 Map，单条路径保持原 findOne（语义不变）
          const taskRow = taskById
            ? (taskById.get(execution.taskId) ?? null)
            : await this.taskRepo.findOne({
                where: { id: execution.taskId },
              });
          isBroadcast = taskRow?.executeMode === "broadcast";
        }

        // P1: atomic terminal transition — the update only lands while the
        // execution is still pending/running, making duplicate callbacks and
        // races with the worker's finally-save harmless. Slot release and log
        // persistence below run exactly once, only for the winner.
        const finishedAt = new Date();
        const patch: Partial<TaskExecution> = {
          endTime: finishedAt,
          duration:
            cb.durationMs ??
            (execution.startTime
              ? finishedAt.getTime() - new Date(execution.startTime).getTime()
              : 0),
        };
        if (cb.status === "success") {
          patch.status = ExecutionStatus.SUCCESS;
          patch.failureReason = null;
        } else {
          const failureReason =
            cb.failureReason ??
            this.inferFailureReason(cb.errorMessage, cb.logs, cb.exitCode);
          patch.status =
            failureReason === ExecutionFailureReason.TIMEOUT
              ? ExecutionStatus.TIMEOUT
              : ExecutionStatus.FAILED;
          patch.failureReason = failureReason;
          if (cb.errorMessage !== undefined) {
            patch.errorMessage = cb.errorMessage;
          }
          // FIX-7.1: 脚本阶段失败的自动 AI 分析——在终态转换**前**触发，
          // 使分析结果同时进终态 patch（一次写库，与 processor 派发失败路径
          // 的 exec.aiAnalysis 同列）与 execution.failed 事件载荷
          // （emitTerminalEvent 读内存 execution.aiAnalysis → 订阅方拿到的
          // 通知与 AI 分析同源）。复用同一开关面：AiAnalysisService
          // fail-open（provider disabled / 内部重试耗尽返回 ""），任何失败
          // 都只跳过分析、绝不阻塞终态落库。回调天然每执行恰一次（winner
          // 语义），无 processor「仅最后一试」要防的重试刷屏问题。
          const failureTask = execution.taskId
            ? taskById
              ? (taskById.get(execution.taskId) ?? null)
              : await this.taskRepo.findOne({
                  where: { id: execution.taskId },
                })
            : null;
          const analysis = await this.autoAnalyzeCallbackFailure(
            failureTask,
            cb,
            failureReason,
          );
          if (analysis) {
            execution.aiAnalysis = analysis;
            patch.aiAnalysis = analysis;
          }
        }
        // 改动2（可观测性补齐）：回调上报的原始退出码入库溯源（终态成败均
        // 适用）。DTO 层已 @IsInt 校验，这里再运行态兜底（handleCallback 还有
        // 内部调用方）：非整数按缺省处理，不写入 patch——绝不把已有值覆盖成 null。
        if (typeof cb.exitCode === "number" && Number.isInteger(cb.exitCode)) {
          patch.exitCode = cb.exitCode;
        }
        if (cb.logs) {
          patch.logs = cb.logs;
        }
        // FEAT-05: 产物清单落库（best-effort）。仅在回调上报非空清单时写入，
        // 绝不在缺省时覆盖成 null——重复/兜底回调不会擦除先前已保存的清单。
        if (Array.isArray(cb.artifacts) && cb.artifacts.length > 0) {
          patch.artifacts = cb.artifacts;
        }
        // python_task_multiversion（FR-12/AC-12a）：执行器上报的结构化留痕
        // （当前是解释器快照 `{requested, resolved, reason, detail, pool}`）。
        //
        // 为什么必须显式透传：回调体走 `ParseArrayPipe({items, whitelist: true})`，
        // 而该 pipe **只带 whitelist、不带 forbidNonWhitelisted**——未被 DTO 声明
        // 的字段会被**静默丢弃**（不报错）。此前 DTO 没有 `result` 字段，于是
        // 执行器辛辛苦苦产出的解释器快照在 admin 边界被无声吃掉，UI 永远拿不到
        // `interpreter_unavailable` 的"请求了哪个版本/池里有什么"，
        // 运维只能看到一个分因、无法定位。DTO 侧已加 `result`（含 4KB/深度约束）。
        //
        // 写入口径与 artifacts 一致：仅上报非空对象时写，**绝不用缺省覆盖成 null**
        // ——重复回调/旧执行器（不带该字段）不得擦除已保存的留痕。
        if (
          cb.result &&
          typeof cb.result === "object" &&
          !Array.isArray(cb.result) &&
          Object.keys(cb.result).length > 0
        ) {
          patch.result = cb.result as Record<string, any>;
        }

        // R-P0-007: Exclude KILLED status to prevent callback from overwriting user-initiated kill
        // 改动4: 携带 RETURNING——用库中实际 executorAddress 决定释放/回填目标。
        // executorAddress 在 dispatch HTTP 返回后才落库（task.processor.ts），
        // 秒级完成的执行其请求前快照 execution.executorAddress 仍为 null，用它
        // 释放会 no-op 使 runningTaskCount 永久虚高；RETURNING 覆盖该落库窗口，
        // 快照仅作 fallback（参照 scheduler.service 的 UPDATE ... RETURNING 模式）。
        // A1: 走统一入口——开放态门槛不再在本文件抄一份字面量（旧实现硬编码
        // [PENDING, RUNNING]，与 scheduler 的 OPEN_EXECUTION_STATUSES 是两份
        // 事实源，加状态必漏改）。
        // 上面 success/非 success 两个分支都已给 patch.status 赋值，此处显式
        // 取出以满足终态入口的类型契约（status 必为终态，入口会再校验一次）。
        const { status: terminalStatus, ...restPatch } =
          patch as Partial<TaskExecution> & { status: ExecutionStatus };
        const updated = await transitionToTerminal(this.execRepo, {
          ids: [cb.executionId],
          patch: { status: terminalStatus, ...restPatch },
          // 重复回调分支按 cb.executorAddress 释放（广播语义），此处无需快照。
        });

        if (!updated.affected) {
          // Already terminal (duplicate callback): report success without
          // releasing the slot again — the first writer already did.
          // 改动3: 但若回调日志此前没落库（上一次 winner 在 storeLogLines 抛错、
          // 整批重试回到此分支），仍补写日志后再返回，闭合"落库失败→日志永久丢失"。
          const fresh = await this.execRepo.findOne({
            where: { id: cb.executionId },
          });
          if (fresh) await this.persistCallbackLogsIfMissing(fresh, cb);
          // R-06（DEEP_REVIEW 0ef3bbe）: 广播场景下，其余 N-1 个被接受执行器的
          // 回调会落到这里（首个回调已把执行行终态化）。它们各占一坑，必须按各自
          // cb.executorAddress 释放——不能因「已终态」而漏掉。非广播执行此分支
          // 保持零释放（winner 已释放一次）。
          if (isBroadcast && cb.executorAddress) {
            await this.releaseExecutorSlot(cb.executorAddress);
          }
          // 可观测性补齐：重复回调（已终态）业务分类计数；终态结果不计数——
          // 执行结果 series 只在唯一 winner 的 UPDATE 命中处记录。
          recordRuntime("autoflow_callback_business_total", {
            result: "duplicate",
          });
          // NETOPT-3②: 依赖扇出的丢失补偿重放。两条此前永久静默丢扇出的
          // 路径都收敛到这里：① 终态提交后、扇出前进程崩溃（执行器整批重发
          // 落到本分支）；② 扇出 trigger 失败（depsFiredAt 刻意留 NULL）。
          // 判据 = 行已是 SUCCESS 终态 且 depsFiredAt 仍为 NULL（扇出全部
          // 成功时已落标记，不会重放——幂等由标记保证，重放内部的 claim
          // 去重再兜一层并发安全）。标记列是旁路信号，非终态，不触碰 A1
          // 状态机。
          if (
            fresh &&
            fresh.taskId &&
            fresh.status === ExecutionStatus.SUCCESS &&
            !fresh.depsFiredAt
          ) {
            this.logger.warn(
              `NETOPT-3②: duplicate callback for SUCCESS execution ${cb.executionId} with depsFiredAt=NULL — replaying dependency fan-out for task ${fresh.taskId}`,
            );
            await this.triggerDependentTasks(fresh.taskId, fresh.id);
          }
          results.push({ executionId: cb.executionId, success: true });
          continue;
        }

        // ARTIFACTS-INDEX-46（部署模型评审 §4.6）：产物元数据索引双轨写——
        // jsonb 清单已随上方 transitionToTerminal patch 落库，这里在**同一
        // 写点**同步 upsert 关系化新表（execution_artifacts），供
        // GET /artifacts?applicationId=&taskId= 索引查询。三要点：
        //  ① 仅 winner 分支执行（重复回调 affected=0 已 continue，天然幂等
        //    不会重放扇出）；
        //  ② 整替语义（先 delete 后 insert）：回调重报清单时以最新上报为准
        //    （与 jsonb 整列覆盖同款语义），唯一 (executionId,name) 不会撞；
        //  ③ best-effort：新表写失败只 warn 不抛——产物清单本身是 best-effort
        //    （FEAT-05 头注），索引表缺失行只影响新查询端点的完备性，绝不能
        //    反过来阻塞终态主链；两侧短暂不一致由下一次上报/TTL 清理收敛。
        //  ④ 触发条件与 jsonb 写点逐字节同款（非空数组才写）——空清单/缺省
        //    上报在 jsonb 侧不覆盖旧值，索引侧同样不动，两侧恒同宽。
        if (
          this.artifactIndexRepo &&
          Array.isArray(cb.artifacts) &&
          cb.artifacts.length > 0
        ) {
          try {
            await this.syncArtifactIndexRows(
              cb.executionId,
              execution.taskId,
              cb.artifacts,
            );
          } catch (err: unknown) {
            this.logger.warn(
              `ARTIFACTS-INDEX-46: execution ${cb.executionId} 产物索引行同步失败（best-effort，jsonb 主链不受影响）: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        // 可观测性补齐：终态条件 UPDATE 命中（winner）——业务受理计数。
        // 第二轮审计（A4）：autoflow_execution_result_total 的记录点已下沉
        // 到 transitionToTerminal 统一终态入口（execution-terminal.ts），
        // 此处不再记录——避免与下沉后的入口双计；同时 kill / 执行器重启 /
        // 扫描回收 / 入队补偿等服务端终态路径在同一入口获得计数。
        recordRuntime("autoflow_callback_business_total", {
          result: "accepted",
        });

        // FIX-4.2: 终态已落库（winner），best-effort 唤醒所有 webhook wait
        // 等待方——发布点在提交之后，唤醒即意味着终态已可见。
        this.publishExecutionWake(cb.executionId);

        // winner 行（RETURNING 结果）为权威：地址/日志持久化都以此为准。
        // A1: 形状归一化（数组/单对象/空 + 驱动不返回行时的快照兜底）已由
        // 统一入口完成，此处不再自己解析 `raw`（旧实现在此重复了一版解析，
        // 且与 scheduler/executor 两处口径不同）。
        const winnerAddress =
          updated.rows[0]?.executorAddress ?? execution.executorAddress;

        // Decrement executor runningTaskCount on task completion (success or
        // failure); exactly once thanks to the conditional update above.
        // 改动4: 优先用 RETURNING 的库中实际地址，快照兜底。
        await this.releaseExecutorSlot(winnerAddress);
        // R-06（DEEP_REVIEW 0ef3bbe）: 广播执行的 winnerAddress 恒为 null（上方
        // no-op），本执行器自己占的坑改按其上报地址释放；非广播执行 winnerAddress
        // 已释放，这里跳过。
        if (isBroadcast && cb.executorAddress) {
          await this.releaseExecutorSlot(cb.executorAddress);
        }

        // ARCH-21（原「改动1」解耦）：终态事件发布——旧的 FAILED/TIMEOUT
        // 直调告警改为 execution.failed（notification 模块监听器复刻等价
        // 语义），并在 SUCCESS 新增 execution.completed（本轮通知侧刻意不
        // 订阅——旧路径成功本就不发通知；事件为 FEAT-07 出站 webhook 铺路）。
        // 放在依赖 fan-out 与日志持久化之前，与旧直调时机点一致：确保即便
        // 后续步骤抛错被 catch 成 success:false（执行器随后会重试整批），
        // 事件也已发出一次；重试路径在 affected=0 分支不再 emit，恰好保持
        // "每个失败执行一次告警"，与终态条件 UPDATE 的 winner 语义一致。
        this.emitTerminalEvent(
          execution,
          patch.status as ExecutionStatus,
          patch.failureReason ?? null,
          cb,
          patch.duration ?? null,
          finishedAt,
        );

        // CORE-04: 超时终态落定后的动作兑现。执行器回调 failureReason=timeout
        // （自身硬超时树杀后上报）且任务配置了非缺省 timeoutAction 时：
        //  - notify_only：admin 不额外动作（告警已由上方改动1路径发出）——
        //    显式 no-op 分支只是让语义可读；
        //  - kill_retry：按任务既有重试预算 re-enqueue 一次新执行（与
        //    executor-restart / stale sweep 共用 hasRetryBudget +
        //    scheduleRetryAfterRecovery，fail-open：预算耗尽/入队失败仅记日志，
        //    终态已落定不受影响）。kill（缺省/null）走到这里即无追加动作。
        // 放在 winner 分支保证恰好一次（duplicate 回调在 affected=0 提前返回）。
        if (patch.status === ExecutionStatus.TIMEOUT) {
          // NETOPT-1⑥: 批量路径查 Map，单条路径保持原 findOne（语义不变）
          const task = !execution.taskId
            ? null
            : taskById
              ? (taskById.get(execution.taskId) ?? null)
              : await this.taskRepo.findOne({
                  where: { id: execution.taskId },
                });
          const action = normalizeTimeoutAction(task?.timeoutAction);
          if (action === "kill_retry" && task) {
            this.logger.warn(
              `CORE-04: timeout action kill_retry for execution ${execution.id} (task "${task.name}")`,
            );
            try {
              await this.executorService.scheduleRetryAfterRecovery(
                task,
                execution,
                "timeout_retry",
              );
            } catch (retryErr: unknown) {
              const retryMsg =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              this.logger.warn(
                `CORE-04: kill_retry re-enqueue failed for execution ${execution.id}: ${retryMsg} (terminal state preserved)`,
              );
            }
          }
          // notify_only：无追加 admin 动作——超时告警已发出（改动1 路径），
          // 执行器侧树杀照常发生。此分支显式留空以承载语义。
        }

        // R4-P0: dependency fan-out lives on the unique-winner path. The
        // worker's in-memory status can only be RUNNING/FAILED/TIMEOUT when
        // its finally block runs (SUCCESS is written exclusively by the
        // conditional UPDATE above), so the previous trigger point in
        // TaskProcessor.handle was dead code and dependency chains never
        // fired. Firing here — after affected > 0 and only for
        // status === SUCCESS — makes duplicate callbacks a no-op (they exit
        // at the affected gate above) and keeps the TASK-004 conditional
        // UPDATE semantics: exactly one caller observes the transition.
        // G6：失败边——失败/超时/取消也进入扇出入口，函数内部只挑
        // `runOnUpstreamFailure` 的下游（未声明者仍按「失败不触发」）。
        if (
          patch.status === ExecutionStatus.SUCCESS ||
          patch.status === ExecutionStatus.FAILED ||
          patch.status === ExecutionStatus.TIMEOUT ||
          patch.status === "killed" ||
          patch.status === "cancelled"
        ) {
          // NETOPT-3②: 传执行行 id——扇出全部成功后在该行落 depsFiredAt 标记。
          await this.triggerDependentTasks(
            execution.taskId,
            cb.executionId,
            patch.status as ExecutionStatus,
          );
        }

        // LOG-01: persist structured log lines for pagination/SSE. When the
        // executor truncated the callback payload, pull the full logs from the
        // executor's /api/logs endpoint instead; on failure fall back to the
        // truncated lines so the log viewer keeps working.
        if (cb.logs) {
          let stored = false;
          if (LOG_TRUNCATION_MARKER.test(cb.logs)) {
            stored = await this.backfillFullLogsFromExecutor(
              { ...execution, executorAddress: winnerAddress ?? null },
              winnerAddress ?? "",
            );
          }
          if (!stored) {
            // RT-LOG: 回调日志是**截断**形态（执行器内存只留头尾）而实时流
            // 已经落了行时，不能再用它整体覆盖——否则用户看到的终态日志比
            // 执行过程中更少。其余情形（无既有行、或回调日志未截断）照常
            // 写入，既有 replace 语义不变。判据与 persistCallbackLogsIfMissing
            // 同源（见 hasStreamedLogLines）。
            const keepStreamed =
              LOG_TRUNCATION_MARKER.test(cb.logs) &&
              (await this.hasStreamedLogLines(cb.executionId));
            if (!keepStreamed) {
              await this.storeLogLines(cb.executionId, cb.logs);
            }
          }
        }

        results.push({ executionId: cb.executionId, success: true });
      } catch (error: unknown) {
        // 可观测性补齐：per-item 异常兜底分支（如日志持久化抛错）——业务
        // 分类计 error；执行结果不计数（终态可能已写入，由 winner 处计数）。
        recordRuntime("autoflow_callback_business_total", { result: "error" });
        results.push({
          executionId: cb.executionId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async saveVersion(
    taskId: string,
    createdBy?: string,
    description?: string,
    taskSnapshot?: Task,
  ): Promise<TaskVersion | null> {
    const task =
      taskSnapshot ?? (await this.taskRepo.findOne({ where: { id: taskId } }));
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", { taskId });
    }

    // Use MAX(version number) + 1 to avoid race condition from COUNT-based numbering
    const maxResult = await this.versionRepo
      .createQueryBuilder("v")
      .select("MAX(CAST(SUBSTR(v.version, 2) AS INTEGER))", "maxNum")
      .where("v.taskId = :taskId", { taskId })
      .getRawOne();
    const versionNum = (maxResult?.maxNum ?? 0) + 1;
    const version = `v${versionNum}`;

    const snapshot: Record<string, unknown> = {
      id: task.id,
      name: task.name,
      description: task.description,
      runtime: task.runtime,
      entrypoint: task.entrypoint,
      // W-21: requirements must ride the snapshot, or a version rollback
      // would silently drop the dependency set the rolled-back task needs.
      requirements: task.requirements,
      params: task.params,
      timeout: task.timeout,
      // CORE-04: 超时策略随快照——缺省时版本回滚不得静默重置为 null（否则
      // "回滚到旧版本"会悄悄改变超时动作/预警配置）。
      timeoutAction: task.timeoutAction,
      timeoutWarnRatio: task.timeoutWarnRatio,
      // CORE-05: 预估时长随快照——否则版本回滚会把已配置的预估静默重置
      // （与上方超时策略两字段同一理由）。
      estimatedDurationSec: task.estimatedDurationSec,
      maxRetry: task.maxRetry,
      retryDelay: task.retryDelay,
      retryableErrors: task.retryableErrors,
      triggerType: task.triggerType,
      cronExpression: task.cronExpression,
      timezone: task.timezone,
      fixedRate: task.fixedRate,
      blockStrategy: task.blockStrategy,
      misfireStrategy: task.misfireStrategy,
      priority: task.priority,
      executeMode: task.executeMode,
      currentVersion: task.currentVersion,
      gitRepo: task.gitRepo,
      gitBranch: task.gitBranch,
      gitCommit: task.gitCommit,
      glueSource: task.glueSource,
      glueLanguage: task.glueLanguage,
      // python_task_multiversion（WS1 · VER-DIFF-01 同型缺口）：快照此前漏了
      // runtimeVersion / codeSource / applicationId 三个**用户可编辑**列
      // （前两者经 create-task.dto 可写，applicationId 经 update 可写）。
      //
      // 后果与 VER-DIFF-01 完全同型，且更严重——rollbackToVersion 用
      // Object.assign 应用快照，**快照缺键即保留当前值**：任务 3.7 → 改成
      // 3.12 → 回滚到"3.7 那一版"后 runtimeVersion 仍是 3.12，版本回滚静默
      // 失效（解释器语义是硬约束，这会让回滚后的任务跑在错误的 Python 上）。
      //
      // 三者必须**一起**入快照，缺一不可：applicationId 单独缺失时，回滚到
      // zip 版本会得到 codeSource='application_zip' 而无 applicationId 的
      // **自相矛盾态**——正是 assertCodeSourceConsistent 要拒的终态，且派发
      // 时拿不到 packageUrl（静默跑错代码，比报错更糟）。
      //
      // 一致性说明：codeSource 入快照后，compareVersions 会把"代码来源变更"
      // 如实显示为差异（键集合派生自快照）——这是期望行为，此前改了来源却
      // 显示"无差异"。
      runtimeVersion: task.runtimeVersion,
      codeSource: task.codeSource,
      applicationId: task.applicationId,
      // VER-DIFF-01（本轮审计）：快照此前漏了这两个**用户可编辑**的列
      // （maintenanceWindows / runbook 经 create-task.dto 可写）。而
      // compareVersions 的键集合是 `new Set([...Object.keys(v1.snapshot),
      // ...Object.keys(v2.snapshot)])` —— 完全派生自快照本身，因此**任何不在
      // 快照里的字段永远不可能出现在版本差异里**：用户改了维护窗口或 runbook，
      // 对比两个版本却显示"无差异"，误导性极强（看起来像改动没生效）。
      maintenanceWindows: task.maintenanceWindows,
      runbook: task.runbook,
      // 第二轮审计（A3 · 版本快照补键）：以下 11 个键全部是**用户可编辑**列
      // （经 create-task.dto / update-task.dto 可写），此前不在快照键集内。
      // 后果与上方 VER-DIFF-01 完全同型且 ×2：① compareVersions 的键集合
      // 完全派生自快照，漏键 ⇒ 改了依赖链/部署约束/告警配置后版本对比
      // 显示"无差异"；② rollbackToVersion 用 Object.assign（缺键保留现值）
      // ⇒ 回滚到旧版本时这些字段静默保留新值——回滚依赖链的任务仍挂着
      // 新依赖、告警配置悄悄漂移，版本回滚对这批字段集体失效。
      // 键名与 create-task.dto.ts / update-task.dto.ts 字段一致；旧快照缺键
      // 由 Object.assign 语义自然向后兼容（保留现值），无须迁移。
      dependencies: task.dependencies,
      deploymentPolicy: task.deploymentPolicy,
      executorAffinityTags: task.executorAffinityTags,
      executorAntiAffinityTags: task.executorAntiAffinityTags,
      executorId: task.executorId,
      executorAppName: task.executorAppName,
      executorGroup: task.executorGroup,
      executorTags: task.executorTags,
      projectId: task.projectId,
      alarmEmail: task.alarmEmail,
      alarmChannels: task.alarmChannels,
      // 刻意**不**纳入 secrets：它虽是实体列，但 GET /tasks/:id/versions 与
      // compare 端点会把 snapshot 原样回传，而 secrets 的脱敏
      // （maskForResponse）只挂在 task 读路径上，不覆盖版本端点。放进来等于
      // 把密文（甚至将来若改动脱敏链路则可能是明文）通过版本历史泄露出去。
      // 回滚不受影响：rollbackToVersion 用 Object.assign，快照缺键即保留原值。
    };

    // B-10（调度域审计）：并发 PATCH 的 MAX+1 竞态——两个并发保存各自算出
    // 同一个 v<N>，迁移 1790000000021 的 (taskId, version) 唯一索引让败者的
    // INSERT 撞 23505。此时任务行已保存、调度已重排（调用方的 save 都已成
    // 功），把快照插入失败裸抛成 500 会让一次已成功的编辑收到错误响应。
    // 版本快照少一条属可接受损失（主流程已成功；R1 先例：executor.service
    // register 对同型竞态同样降级），识别 23505 后 warn 并返回 null，不回
    // 500。版本保留策略（挤出一类）另行处理，不在本修复范围。
    try {
      return await this.versionRepo.save(
        this.versionRepo.create({
          taskId,
          version,
          gitCommit: task.gitCommit,
          snapshot,
          createdBy,
          description,
        }),
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        this.logger.warn(
          `saveVersion: concurrent version snapshot insert for task ${taskId} lost the race (unique violation on (taskId, version)) — skipping this snapshot, main flow unaffected`,
        );
        return null;
      }
      throw err;
    }
  }

  async getVersions(taskId: string): Promise<TaskVersion[]> {
    // O-7：版本表无上限拉取会随历史版本数线性膨胀；固定取最近 100 条
    // （已按 createdAt DESC），避免长尾任务一次性把全部版本读入内存。
    return this.versionRepo.find({
      where: { taskId },
      order: { createdAt: "DESC" },
      take: 100,
    });
  }

  async getVersion(taskId: string, versionId: string): Promise<TaskVersion> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId, taskId },
    });
    if (!version) {
      throw new AppError("TASK_VERSION_ID_NOT_FOUND", { taskId });
    }
    return version;
  }

  async rollbackToVersion(
    taskId: string,
    versionId: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<Task> {
    const version = await this.getVersion(taskId, versionId);

    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", { taskId });
    }

    // R-03: 写面归属守卫（镜像 update 口径）。本路径直接以 repo 查询取
    // RAW 实体（无脱敏，快照亦不含 secrets），无 R-01 掩码回写问题。
    await this.assertCanWriteProjectAware(task, user);

    // FEAT-RENAME：快照含 name（saveVersion 显式入快照，见其 snapshot 装配），
    // 故回滚会把任务名一起还原成那一版的样子——这是既有的快照语义，保留。
    // 但改名放开后，这条路径必须与 update() 补齐同样的两件事，否则它是绕过
    // 新约束的旁路：
    //   ① 撞 idx_tasks_name_unique（还原的名字可能已被别的任务占用）——此前
    //      裸抛 QueryFailedError → 全局过滤器给笼统 500/409，用户不知道撞了
    //      什么；update() 已有可读文案，这里必须对齐。
    //   ② 引用方的依赖显示名 key 会残留旧名——update() 会刷新，回滚同样要刷。
    const previousName = task.name;

    // R63-A1（ADR-026 规则 4）：写面从「Object.assign(snapshot) + save(task)」
    // 收窄成「正向白名单 ∩ 采纳集（快照真的带了的键）」的列级条件写。
    //
    // 旧实现的两种现形方式：
    //   ① 窗口内并发 PATCH 写的 description / cronExpression 等**快照外**的列，
    //      被整行 save 从旧快照盖回去（用户的并发编辑静默丢失）；
    //   ② 窗口内并发 remove 把行软删，整行 save 把 deletedAt 写回 NULL
    //      ——**软删行复活**（status 一起被写回 active）。
    // 语义不变的部分：快照里带的列照常覆盖（版本恢复的本意）；快照缺键保留现值
    // （旧快照向后兼容，理由见 saveVersion 的 11 键注释）。行谓词恒带
    // `deletedAt IS NULL`——命中 0 = 行已被并发软删 → 规则 3 让位（404），
    // 不按旧快照写回。
    const snapshot = version.snapshot as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const column of VERSION_ROLLBACK_COLUMNS) {
      if (!(column in snapshot)) continue;
      // undefined = 该版本没有这一列的取值 → 保留现值（null 是显式清空，照写）
      if (snapshot[column] === undefined) continue;
      patch[column] = snapshot[column];
    }
    // 当前版本号以本次应用的版本为准（快照里的 currentVersion 是"那一版当时"的值）
    patch.currentVersion = version.version;

    let applied: boolean;
    try {
      applied = await this.patchTaskColumns(taskId, patch);
    } catch (err) {
      if (
        isUniqueViolation(err) &&
        uniqueConstraintName(err) === "idx_tasks_name_unique"
      ) {
        throw new AppError("TASK_ROLLBACK_NAME_TAKEN", {
          version: version.version,
          name: String(patch.name ?? task.name),
        });
      }
      throw err;
    }
    if (!applied) {
      // 规则 3：行谓词落空 = 并发 remove 已软删该行。与"顺序执行时任务已不存在"
      // 同解（404），绝不按旧快照写回（那正是软删行复活的入口）。
      throw new AppError("TASK_NOT_FOUND", { taskId });
    }
    // 回读写面结果：不把方法早期读到的快照当"本次写的结果"返回（同 pause/resume）
    const saved =
      (await this.taskRepo.findOne({ where: { id: taskId } })) ??
      (Object.assign(task, patch) as Task);
    await this.saveVersion(saved.id, undefined, undefined, saved);
    // 与 update() 同源：回滚若改变了任务名，同步刷新引用方的依赖别名
    if (previousName !== saved.name) {
      await this.renameDependencyAlias(saved.id, previousName, saved.name);
    }
    // B-2（调度域审计）：回滚整体覆盖含 triggerType/cronExpression/fixedRate
    // 的快照——若不重排调度，已注册的定时器仍按**旧表达式**继续触发（reload
    // 只为「未注册」的任务建定时器，感知不到已注册任务的配置变化）。与
    // update() 对齐：先停旧定时器，ACTIVE 任务再按新配置重建。
    this.schedulerService.stop(taskId);
    if (saved.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(saved);
    }
    return saved;
  }

  async compareVersions(
    taskId: string,
    versionId1: string,
    versionId2: string,
  ): Promise<Record<string, { old: unknown; new: unknown }>> {
    const v1 = await this.getVersion(taskId, versionId1);
    const v2 = await this.getVersion(taskId, versionId2);

    const allKeys = new Set([
      ...Object.keys(v1.snapshot),
      ...Object.keys(v2.snapshot),
    ]);
    const diff: Record<string, { old: unknown; new: unknown }> = {};

    for (const key of allKeys) {
      if (
        JSON.stringify(v1.snapshot[key]) !== JSON.stringify(v2.snapshot[key])
      ) {
        diff[key] = {
          old: v1.snapshot[key],
          new: v2.snapshot[key],
        };
      }
    }

    return diff;
  }

  // VER-DIFF-02（本轮审计）：原先此处有一个 `deleteVersion(taskId, versionId)`
  // 方法，但**全仓无任何调用方、controller 也没有对应路由**（版本面只暴露
  // 列表 / 对比 / 回滚三条）——是纯死代码，且它是本服务唯一一个**不带归属守卫**
  // 的变更方法，构成潜在陷阱：将来有人顺手接一条
  // `DELETE /tasks/:id/versions/:versionId`，就会让任意已登录用户删掉别人任务的
  // 版本历史（版本历史是回滚能力的依托，删掉不可恢复）。
  //
  // 选择**删除**而不是补守卫：补守卫需要给定「无 user 内部调用」的语义，而该
  // 约定此前不存在、也无从验证（assertCanWrite 对 ownerUserId 非 null + user
  // 缺省是拒绝的）。删除死代码同时消除陷阱，比发明一个没有消费方的契约更诚实。
  // 若日后确需删除版本，请带 user 参数接线并复用 assertCanWriteProjectAware。

  /** Get scheduler running status statistics */
  getSchedulerStats() {
    return this.schedulerService.getStats();
  }

  /**
   * FEAT-18（ARCH-21 预留补发）：killExecution 的 KILLED 翻转落库后发布
   * `execution.killed` 领域事件。
   *
   * - 时机：条件 UPDATE（status IN (PENDING,RUNNING)）命中（affected>0）之后，
   *   即"已提交的既成事实"——与 ARCH-21 总线时序契约一致。
   * - 载荷形状对齐 emitTerminalEvent 的 ExecutionTerminalEventPayload
   *   （taskId/taskName/failureReason/durationMs/finishedAt），使 notification
   *   listener 与 FEAT-07 出站派发器可复用同一条失败类消费路径。
   * - fail-open：@Optional 注入的 eventBus 为 null 时静默跳过（既有单测装配
   *   兼容，先例同 emitTerminalEvent）；emit 本身被总线兜底 + try/catch 二道
   *   保险丝，绝不影响 kill 主链结果。
   */
  private emitKilledEvent(
    execution: TaskExecution,
    durationMs: number | null,
    finishedAt: Date,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutionTerminalEventPayload = {
      executionId: execution.id,
      taskId: execution.taskId ?? null,
      taskName: execution.taskName ?? execution.taskId,
      status: "killed",
      failureReason: ExecutionFailureReason.KILLED,
      errorMessage: "管理员手动终止",
      aiAnalysis: execution.aiAnalysis ?? null,
      durationMs,
      finishedAt: finishedAt.toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTION_KILLED, payload);
    } catch {
      /* never reached with DomainEventBus's fail-open contract */
    }
  }

  /** Force-terminate a running execution */
  async killExecution(
    execId: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<{ success: boolean; message: string }> {
    const execution = await this.execRepo.findOne({ where: { id: execId } });
    if (!execution) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId: execId,
      });
    }
    // A2-B: 终止执行是写面且声明 'ownership'——此前任何登录用户都能终止他人
    // 任务的执行。补上属主守卫（project editor/admin 同样放行，与 update 同档）。
    await this.assertCanWriteExecution(execution, user);

    // R-P0-007: Use conditional update instead of save() to prevent race conditions
    // Only allow killing PENDING or RUNNING executions
    const now = new Date();
    const duration = execution.startTime
      ? Date.now() - new Date(execution.startTime).getTime()
      : null;

    // A1: 走统一入口。RETURNING 取库中实际 executorAddress——快照
    // execution.executorAddress 可能因 dispatch 尚未落库而为 null，用它决定
    // 释放/终止目标会 no-op（槽位虚高、执行器继续空跑）；快照仅作为「驱动命中
    // 但未返回行」时的兜底（该兜底现由 transitionToTerminal 统一提供）。
    const result = await transitionToTerminal(this.execRepo, {
      ids: [execId],
      patch: {
        status: ExecutionStatus.KILLED,
        endTime: now,
        duration: duration,
        errorMessage: "管理员手动终止",
        failureReason: ExecutionFailureReason.KILLED,
      },
      addressSnapshot: { [execId]: execution.executorAddress ?? null },
    });

    if (!result.affected || result.affected === 0) {
      throw new AppError("TASK_EXECUTION_TERMINAL", {
        status: execution.status,
      });
    }

    // FEAT-18: KILLED 终态已落库（UPDATE 命中 winner），发布 execution.killed。
    // emit 在通知执行器/释放槽位之前——事件即既成事实，后续步骤全是 best-effort
    // 副作用，任何失败都不回头改库（与 ARCH-21「落库后即 emit」时序契约一致）。
    this.emitKilledEvent(execution, duration, now);
    // FIX-4.2: 终态唤醒（webhook wait 等待方；与 emit 同为落库后的旁路副作用）。
    this.publishExecutionWake(execId);

    // 改动4: 优先用 RETURNING 的库中实际地址，快照作 fallback。
    // A1: raw 的形状归一化（数组/单对象/空）与「驱动命中但未返回行」的兜底
    // 都由统一入口完成，此处不再自行解析（旧实现在本文件里重复了两版解析）。
    const executorAddress =
      result.rows[0]?.executorAddress ?? execution.executorAddress ?? null;

    await this.releaseExecutorSlot(executorAddress);
    // 改动5: 通知执行器真正终止进程（best-effort；地址为空则跳过，
    // 任何失败都在 notifyExecutorKill 内被吞掉）。
    // P2-3: 透传行身份 execution.executorId（findOne 快照；存量行为 null →
    // 上层回落 address 寻路）——pull 同址多行时 kill 必须送达正确行。
    await this.notifyExecutorKill(
      execId,
      executorAddress,
      execution.executorId,
    );
    this.logger.warn(`Execution ${execId} has been manually terminated`);
    return { success: true, message: "Execution marked as terminated" };
  }
}

/**
 * Stream a UTF-8 text log line by line, returning the page [fromLine,
 * fromLine+limit). The full document is read once but no full string or
 * full line-array is ever materialized — only the slice the caller asked
 * for plus the running total. Lines themselves are short-lived; the total
 * count is exposed as `totalLines` so the caller can paginate further.
 *
 * OBS-03: opts.level（可选）启用级别过滤。S3 对象是纯 gzip 文本，级别未
 * 随对象持久化，无法在存储层下推过滤——只能整流解码后逐行用 levelOfLine
 * 重推断。取舍：正确性优先于数据量——MAX_LOG_BYTES（见 s3-log-storage）
 * 已为解码体积兜底上限，重推断是 O(lines) 纯文本扫描，可接受；若未来
 * 日志对象带侧车索引（level→line ranges）可再优化。
 *
 * level 过滤下 fromLine 的语义是"过滤后序列的偏移量"（与 DB 路径的
 * OFFSET 模式一致）：被过滤掉的行不占用分页窗口，也不计入 totalLines——
 * totalLines 是"过滤后总行数"，hasMore 由过滤后行集计算。未传 level 时
 * 行为与 OBS-03 之前逐字节一致。
 */
async function paginateLogStream(
  stream: Readable,
  fromLine: number,
  limit: number,
  opts: { level?: string | null } = {},
): Promise<{ lines: string[]; totalLines: number; hasMore: boolean }> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const out: string[] = [];
  let idx = 0; // physical line index (unfiltered)
  let matched = 0; // OBS-03: lines surviving the level filter
  for await (const line of rl) {
    if (opts.level) {
      if (levelOfLine(line) !== opts.level) continue;
      if (matched >= fromLine && out.length < limit) out.push(line);
      matched++;
    } else {
      if (idx >= fromLine && out.length < limit) out.push(line);
      idx++;
    }
  }
  const totalLines = opts.level ? matched : idx;
  return {
    lines: out,
    totalLines,
    hasMore: fromLine + out.length < totalLines,
  };
}
