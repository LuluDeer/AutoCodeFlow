import { createInterface } from "node:readline";
import { Logger } from "@nestjs/common";
import type { Readable } from "node:stream";
import { Between } from "typeorm";
import type { Repository } from "typeorm";

import { TaskExecution } from "./entities/task-execution.entity";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { Task } from "./entities/task.entity";
import { S3LogStorage } from "./log-storage/s3-log-storage";
import { AppError } from "../../common/errors/app-error";
import { ExecutionStatus } from "./entities/task-execution.entity";
import { levelOfLine } from "./log-level.util";
import { UserRole } from "../users/entities/user.entity";
// R284-LOGPURGE-01：运行期保留期配置键（与 LogRetentionCleanupService 同一事实源）
import { LOG_RETENTION_CONFIG_KEY } from "./log-retention/log-retention-cleanup.service";

/**
 * T2-B4 收尾刀：**执行日志读面**（分页 / SSE 流 / AI 分析）。
 *
 * ## 这一刀搬了什么（3 个方法 + 1 个纯计算辅助）
 *
 * | 成员 | 改前 `task.service.ts` 行号 | 耦合形式（扫描器实测） |
 * |---|---|---|
 * | `getExecutionLogs` | `:3522-3607`（86 行） | **① 直调 ×14**（全 public API） |
 * | `streamExecutionLogs` | `:3697-3923`（219 行） | **① 直调 ×8**（全 public API） |
 * | `analyzeExecution` | `:3423-3483`（56 行） | **① 直调 ×5**（全 public API） |
 * | `logPartitionWindow` | `:3505-3520`（16 行） | 0（**纯计算**，随簇搬迁） |
 *
 * ## ⚠️ S3：实现留 Facade（**本轮真机未验** ⇒ 不搬）
 *
 * `getExecutionLogs` / `streamExecutionLogs` 各有一处 S3 读取分支
 * （`exec.logStorage === "s3"` ⇒ `s3.getStream(...)`，失败回落 DB 行）。
 * **S3 路径本仓尚未真机验证**（smoke-matrix 明确「留 compose 轮」）⇒
 * 本刀**不搬 S3 运行态**：`resolveS3Storage`（持有 `configService` + 两个缓存
 * 字段）与 `s3GetExistingLog` 留 Facade，经**注入回调**使用。
 *
 * ⇒ **本刀搬的是「不碰 S3 的读面」**：S3 分支的**代码形态**搬了（它在协作者内），
 * 但**后端解析与缓存**仍在 Facade ⇒ S3 真机出问题时的排查路径不变。
 *
 * ## 注入面（**窄签名**）
 *
 * | 成员 | 留 Facade 的理由 | 谁在用它 |
 * |---|---|---|
 * | `resolveS3Storage` | 持有 `configService` + 两个**缓存字段**（`s3LogStorage`/`s3StorageResolved`）⇒ 搬走会变成两份缓存各写各的 | 本类的 S3 分支 |
 * | `acquireSseSlot` | 触碰 **SSE 并发闸**的运行态（`sseStreamsPerExecution` / `sseStreamsGlobal` / `sseMaxPerExecution`）⇒ 属 SSE 域 | 本类的 `streamExecutionLogs` |
 * | `maybeNotifyTimeoutWarning` | 超时预警**副作用**（发通知 + 埋点）⇒ 属通知域 | 本类的 `streamExecutionLogs` |
 * | `assertCanWriteExecution` | **AUTH 守卫**职责 | 本类的 `analyzeExecution` |
 * | `resolveLogRetentionDays` | 读 `configService`（Facade 已注入），且必须与 `LogRetentionCleanupService.resolveRetentionDays` 同源 | R284 的 `logsPurged` 判定 |
 */

/**
 * R284-LOGPURGE-01：日志读面的「已按保留期清理」三态。
 *
 * `known:false` = **未知**（保留期不可知 / 无基准时刻）——前端必须与
 * 「已清理」「真没输出」用**不同**文案，不可互相替代（R278 的 `null≠0` 纪律：
 * 「未知」不是「空」）。
 */
export interface LogsPurgedState {
  /** 判定是否**可下结论**（false ⇒ 另两个字段无意义，前端走"未知/读取失败"）。 */
  known: boolean;
  /** 日志确已被保留期清理（仅 `known:true` 时有意义）。 */
  purged: boolean;
  /** 清理截止时刻（`now − logRetention.days`）；仅 `purged:true` 时非 null。 */
  at: Date | null;
}

/** 注入回调面（**窄签名**）。 */
export interface ExecutionLogReadDeps {
  /** 执行记录仓库。 */
  execRepo: Repository<TaskExecution>;
  /** 日志行仓库。 */
  logLineRepo: Repository<ExecutionLogLine>;
  /** 任务仓库。 */
  taskRepo: Repository<Task>;
  /** 日志（**必须是 Facade 的实例**）。 */
  logger: Logger;
  /** AI 失败分析（`analyzeExecution`）。 */
  aiAnalysisService: {
    analyzeFailure: (
      task: Pick<{ name: string; runtime: string }, "name" | "runtime">,
      logs: string,
      context?: {
        failureReason?: string | null;
        exitCode?: number | null;
        runbook?: string | null;
      },
    ) => Promise<string>;
  };
  /** S3/MinIO 日志后端解析（**留 Facade**：持有 configService + 两个缓存字段）。 */
  resolveS3Storage: () => S3LogStorage | null;
  /** 占位（SSE 并发闸；**留 Facade**：触碰 SSE 运行态）。 */
  acquireSseSlot: (execId: string) => () => void;
  /** 超时预警（**留 Facade**：通知副作用）。 */
  maybeNotifyTimeoutWarning: (exec: TaskExecution, task: Task) => Promise<void>;
  /** 执行记录的属主守卫（**留 Facade**：AUTH 职责）。 */
  assertCanWriteExecution: (
    execution: { taskId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ) => Promise<void>;
  /**
   * R284-LOGPURGE-01：日志保留期解析所需的两个只读依赖（**解析逻辑在本类**）。
   *
   * 为什么要它们而不是一个 `() => Promise<number>` 回调：回调会把「怎么读配置」
   * 留在 Facade，而 Facade 每加一个方法就要动 `task.service.ts`（已顶格文件，
   * 净增必红）。这里只注入**读配置的能力**，回落链写在本类内——它与
   * `LogRetentionCleanupService.resolveRetentionDays` 逐字同序（system_configs
   * 运行期键 → configService → null，**不猜默认值**）。
   */
  configService: { get: <T>(key: string) => T | undefined };
  /** 运行期配置（中台「系统配置」可改）。null = 未装配（单测/旧装配）⇒ go env。 */
  systemConfig: {
    findOne: (key: string) => Promise<{ value: string } | null>;
  } | null;
}

export class ExecutionLogRead {
  private readonly deps: ExecutionLogReadDeps;

  constructor(deps: ExecutionLogReadDeps) {
    this.deps = deps;
  }

  /**
   * R284-LOGPURGE-01：日志保留期天数（与 `LogRetentionCleanupService`
   * **同一条回落链**，否则读面用一套天数判"已清理"、清理 job 用另一套天数真删
   * ——两份事实源必然漂移出「说没清理但行已被删」）。
   *
   * 回落顺序与清理 job 逐字一致：运行期配置 `logRetention.days`（中台可改、
   * 即时生效）→ `configService.get("logRetention.days")`（env/Joi 默认）→
   * **null**。返回 null 表示**读不到/非法**，此时判定给未知态——**不猜 30**：
   * 猜出来的数字会变成一条可能错误的断言，而这条断言正是用户复盘引用的证据。
   */
  private async resolveLogRetentionDays(): Promise<number | null> {
    const runtime = this.deps.systemConfig;
    if (runtime) {
      try {
        const row = await runtime.findOne(LOG_RETENTION_CONFIG_KEY);
        const parsed = Number.parseInt(row?.value ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      } catch {
        // 键不存在 / 配置服务短暂不可用 ⇒ 继续回落（与清理 job 同姿态）。
      }
    }
    const configured = this.deps.configService.get<number>("logRetention.days");
    if (
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured > 0
    ) {
      return configured;
    }
    return null;
  }

  /**
   * R284-LOGPURGE-01：**「日志已被保留期清理」的读面推导**（三态，绝不猜）。
   *
   * ## 为什么需要它（真事故形态）
   *
   * 日志行留 30 天（`LogRetentionCleanupService` / `logRetention.days`），
   * 而执行行留 90 天。⇒ 翻 31~90 天前的执行详情，日志区是一个**空 `<pre>`**，
   * 而唯一空态文案说的是「切日志级别」——用户读成「这次执行没输出 / 采集坏了」，
   * 复盘里写「没有证据」。**真相是证据已按策略删除**，这不是同一个事实。
   *
   * ## 三态（与前端三态文案一一对应）
   *
   * | 判据 | 返回 | 含义 |
   * |---|---|---|
   * | 保留期不可知 | `{known:false}` | **未知**——既不能说已清理，也不能说没输出 |
   * | 日志非空 | `{known:true, purged:false, at:null}` | 有日志，不需要解释空态 |
   * | 日志为空 且 基准时刻早于 `now − days` | `{known:true, purged:true, at:<截止时刻>}` | 已按策略清理 |
   * | 日志为空 且 基准时刻在窗口内 | `{known:true, purged:false, at:null}` | **真没输出** |
   *
   * ## ⚠️ 为什么不能只按时间推
   *
   * 「30 天前 ⇒ 已清理」是错的：30 天前也可能**本来就一个字都没输出**（任务
   * 秒失败、被 kill 在派发前、合成行从未运行）。仅按时间判会把「真没输出」
   * 谎报成「已清理」，那只是把一种误导换成另一种。故判据是**两条同时成立**：
   * ① 该执行窗口的日志行数为 0；② 基准时刻早于清理截止。
   * 任意一条不成立 ⇒ 都不是 purged。这也自动覆盖「清理 job 停摆」：窗口外
   * 但行还在 ⇒ 不判 purged（走「有日志」，本来也不显示空态）。
   *
   * ## 不新增迁移
   *
   * 只靠 `createdAt`/`startTime` + 保留期配置 + 「日志为空」三条**读面推导**，
   * 不落任何新列（落列会变成第二份可能与清理 job 漂移的事实源）。
   *
   * ## 「日志为空」的口径
   *
   * 按**日志行表**计数（与 `getExecutionLogs` 的分页读面同一事实源），不是按
   * `task_executions.logs` 文本列——后者可能留着回调快照而日志行早已被清理，
   * 用它会得出「有日志」却读不出任何行的自相矛盾。计数范围与 `getExecutionLogs`
   * 的分区窗口一致。
   */
  private async deriveLogsPurged(
    exec: Pick<
      TaskExecution,
      "id" | "startTime" | "createdAt" | "endTime" | "logStorage"
    >,
    now: Date,
  ): Promise<LogsPurgedState> {
    const days = await this.resolveLogRetentionDays();
    if (days === null) {
      // 保留期读不到 ⇒ 不可知。**不回落默认 30**：猜一个数字就把"未知"变成
      // 一个可能错的断言，而这个断言正是用户复盘时要引用的证据。
      return { known: false, purged: false, at: null };
    }
    const window = this.logPartitionWindow(exec);
    const lineCount = await this.deps.logLineRepo.count({
      where: {
        executionId: exec.id,
        createdAt: Between(window.since, window.until),
      },
    });
    if (lineCount > 0) {
      return { known: true, purged: false, at: null };
    }
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const base = exec.startTime ?? exec.createdAt ?? null;
    const baseAt = base ? new Date(base) : null;
    if (baseAt === null || !Number.isFinite(baseAt.getTime())) {
      // 没有可比对的时刻（理论不可达：createdAt 恒非空）⇒ 仍不可知。
      return { known: false, purged: false, at: null };
    }
    if (baseAt.getTime() < cutoff.getTime()) {
      return { known: true, purged: true, at: cutoff };
    }
    return { known: true, purged: false, at: null };
  }

  /**
   * 日志分区窗口（**纯计算**，随本簇搬迁）。
   *
   * 按执行的起止时刻各外扩 1 小时，给分区表的边界留余量（分区边界对齐小时，
   * 边界外的行仍要能查到）。
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
    const exec = await this.deps.execRepo.findOne({ where: { id: execId } });
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
        const s3 = this.deps.resolveS3Storage();
        if (s3) {
          const stream = await s3.getStream(exec.logObjectKey);
          const result = await paginateLogStream(stream, fromLine, safeLimit, {
            level: level ?? null,
          });
          // R284：S3 内容为空同样要能说清"为什么空"（对象被 S3LogObjectRetention
          // 回收 ⇒ 指针被清空后根本进不了本分支；能进来但内容为空 ⇒ 真没输出）。
          return {
            ...result,
            ...(await this.purgedFields(exec, result.lines)),
          };
        }
      } catch (err: unknown) {
        this.deps.logger.warn(
          `Failed to read S3 logs for execution ${execId} (${err instanceof Error ? err.message : String(err)}) — falling back to DB log lines`,
        );
      }
    }
    // N10: use typed logLineRepo instead of string-based getRepository
    // CODE-01: fetch true total in parallel so pagination metadata is accurate
    // OBS-03: level 过滤在 SQL 层下推（level = :level）；未传 level 时查询
    // 形态与 OBS-03 之前完全一致（行号游标 + 全量 count），存量行为不变。
    const qb = this.deps.logLineRepo
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
        ? this.deps.logLineRepo.count({
            where: {
              executionId: execId,
              level,
              createdAt: Between(logWindow.since, logWindow.until),
            },
          })
        : this.deps.logLineRepo.count({
            where: {
              executionId: execId,
              createdAt: Between(logWindow.since, logWindow.until),
            },
          }),
    ]);
    const page = {
      lines: lines.map((r) => r.content),
      // CODE-01: true total count, not (currentBatch + offset)
      totalLines,
      hasMore: fromLine + lines.length < totalLines,
    };
    // R284-LOGPURGE-01：日志区为空时必须能说清是「已按保留期清理」还是
    // 「真没输出」——而不只是返回空数组（空数组是一个没有宾语的事实）。
    return { ...page, ...(await this.purgedFields(exec, page.lines)) };
  }

  /**
   * R284：把 `LogsPurgedState` 摊平成响应字段（`logsPurged` / `logsPurgedAt`）。
   *
   * **只在整页为空时**判定：非空页永远不是「用户看到空日志区」的场景，
   * 而每次分页都多打一次 count 是无谓的成本。第一页（`fromLine=0`）为空
   * 即等于「这条执行没有可读日志行」。
   */
  private async purgedFields(
    exec: Pick<
      TaskExecution,
      "id" | "startTime" | "createdAt" | "endTime" | "logStorage"
    >,
    lines: string[],
  ): Promise<{ logsPurged: boolean | null; logsPurgedAt: string | null }> {
    // 有行 ⇒ 明确不是 purged（known 恒 true，不需要再查保留期）。
    if (lines.length > 0) return { logsPurged: false, logsPurgedAt: null };
    const state = await this.deriveLogsPurged(exec, new Date());
    // known:false ⇒ **null**（未知），绝不写成 false —— "没判定出来" 与
    // "判定为没清理过" 是两个事实（R278 null≠0 纪律）。
    if (!state.known) return { logsPurged: null, logsPurgedAt: null };
    return {
      logsPurged: state.purged,
      logsPurgedAt: state.at ? state.at.toISOString() : null,
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
    const releaseSlot = preAcquiredSlot ?? this.deps.acquireSseSlot(execId);
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
      const exec = await this.deps.execRepo.findOne({
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
            task: await this.deps.taskRepo.findOne({
              where: { id: exec.taskId },
            }),
          };
        }
        if (warnTaskCache.task) {
          await this.deps.maybeNotifyTimeoutWarning(exec, warnTaskCache.task);
        }
      }

      // LOG-02: S3 objects are uploaded once at callback time, so their lines
      // become readable only after the execution reaches a terminal state;
      // stream whatever has not been sent yet, then stop.
      if (exec.logStorage === "s3" && exec.logObjectKey) {
        const terminal = TERMINAL_STATUSES.includes(exec.status);
        if (terminal && !s3FetchFailed) {
          try {
            const s3 = this.deps.resolveS3Storage();
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
            this.deps.logger.warn(
              `Failed to stream S3 logs for execution ${execId} (${err instanceof Error ? err.message : String(err)}) — stopping S3 streaming`,
            );
          }
        }
        return terminal;
      }

      // P1（第 6 轮）：与 REST 同款分区窗口——SSE 每 1s 一拍、并发 64 条时
      // 没有分区裁剪就是 31× 的分区索引探测。
      const sseLogWindow = this.logPartitionWindow(exec);
      const lines = await this.deps.logLineRepo
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
  /**
   * On-demand AI analysis for an execution.
   * Fetches the task by name, runs analyzeFailure with the execution logs,
   * persists the result, and returns the updated execution.
   */
  async analyzeExecution(
    execId: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<TaskExecution> {
    const exec = await this.deps.execRepo.findOne({ where: { id: execId } });
    if (!exec) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId: execId,
      });
    }
    // A2-B: 同上——声明 'ownership' 却无校验的缺口，补属主守卫。
    await this.deps.assertCanWriteExecution(exec, user);
    // Use errorMessage + logs as analysis input; fall back gracefully when logs are empty
    const logContent =
      [exec.errorMessage, exec.logs].filter(Boolean).join("\n") || "(no logs)";
    // FIX-6.2: prompt 上下文补全——runtime 此前恒传 "unknown"（AI 拿不到真实
    // 运行时，结论泛化）；现从任务行取真实 runtime，并带上平台已判定的
    // failureReason / exitCode 与任务级 runbook（与通知链路同源）。任务行
    // 不可得（软删/无 taskId）时逐字段退化为旧行为，端点语义零破坏。
    const taskRow = exec.taskId
      ? await this.deps.taskRepo.findOne({ where: { id: exec.taskId } })
      : null;
    const task = {
      name: taskRow?.name ?? exec.taskName ?? "unknown",
      runtime: taskRow?.runtime ?? "unknown",
    };
    // ARCH-30: 走服务化封装（重试 1 次 + 指标 + 永不抛错）；空串结果原样
    // 落库（前端按"无分析"降级渲染），与此前直调 AiService 的空串语义一致。
    const analysis = await this.deps.aiAnalysisService.analyzeFailure(
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
    // 旧实现是 `this.deps.execRepo.save(exec)`——把方法早期读到的**执行行快照**整行
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
    await this.deps.execRepo.update({ id: exec.id }, { aiAnalysis: analysis });
    // 返回读侧视图：取库中当前行而不是方法早期快照，避免把窗口内已经变化的
    // status/endTime 一并回给前端（会让详情页显示"已完成但仍 RUNNING"）。
    const fresh = await this.deps.execRepo.findOne({ where: { id: exec.id } });
    return fresh ?? { ...exec, aiAnalysis: analysis };
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
/**
 * S3 流的分页（**导出仅供单测**——它是纯逻辑，边界多，值得独立钉住）。
 *
 * ⚠️ 导出不改行为（模块级函数 ⇒ 本文件内调用不变）；生产代码没有任何地方
 * 从外部 import 它。
 */
export async function paginateLogStream(
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
