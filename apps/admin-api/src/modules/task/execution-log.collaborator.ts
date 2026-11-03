import { Logger } from "@nestjs/common";
import { LOG_TRUNCATION_MARKER } from "./log-truncation-marker.util";
import { Between } from "typeorm";
import type { DataSource, Repository } from "typeorm";

import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { TaskExecution } from "./entities/task-execution.entity";
import { levelOfLine } from "./log-level.util";
import { AppError } from "../../common/errors/app-error";
import { S3LogStorage } from "./log-storage/s3-log-storage";

/**
 * T2-B4 第三刀：**执行日志读面与写入**协作者。
 *
 * ## 这一刀搬了什么（4 个方法）
 *
 * | 成员 | 改前 `task.service.ts` 行号 | 说明 |
 * |---|---|---|
 * | `storeLogLines` | `:4844-4925`（82 行） | 写入执行日志行；**含自己的 `dataSource.transaction`（`:4910`）** |
 * | `appendLogChunk` | `:4945-4986`（42 行） | 追加一段日志（**public**，被 `execution-callback.controller.ts:421` 直调）；**含自己的 transaction（`:4973`）** |
 * | `persistCallbackLogsIfMissing` | `:5367-5407`（41 行） | 回调日志缺失时补写（**无自己的事务**） |
 * | `hasStreamedLogLines` | `:5415-5417`（3 行） | 是否已有实时流式日志行（纯读） |
 *
 * ## ⚠️ 事务边界（本刀的关键约束）
 *
 * `storeLogLines`（tx `:4910`）与 `appendLogChunk`（tx `:4973`）**各有自己的
 * 事务，且互不调用**（实测：`appendLogChunk` **不调** `storeLogLines`，反之亦然
 * ⇒ 二者不是嵌套事务链，而是两条独立的事务路径）。
 * ⇒ 搬入协作者后，**两个事务体整体在同一 owner 内**，没有被拆到两处。
 *
 * `persistCallbackLogsIfMissing` **无自己的事务**（它只调 `storeLogLines` /
 * `hasStreamedLogLines` / `backfillFullLogsFromExecutor`）⇒ 随簇搬迁无事务风险。
 *
 * ## ⚠️ assign 覆写仍然有效（本刀最关键的一条）
 *
 * 既有 spec 用**赋值式覆写**隔离副作用（不是 spy）：
 *   · `execution-attempt-seq.spec.ts:576` `service.storeLogLines = jest.fn(...)`
 *   · `execution-attempt-seq.spec.ts:577` `service.hasStreamedLogLines = jest.fn(...)`
 *   · `failure-classification.consumer-e2e.spec.ts:171` / `:172` 同款
 *
 * 覆写打在 **Facade 的属性**上。若协作者内部直调**自己的** `storeLogLines`，
 * 覆写就**打不到** ⇒ 隔离性**静默丢失**（测试仍绿但断言变弱——比变红危险）。
 *
 * ⇒ 做法：**Facade 保留同名方法（转发到本类）**，而**协作者内部一律经
 * `deps.storeLogLines` / `deps.hasStreamedLogLines` 回调调用 Facade 的转发方法**
 * ⇒ 覆写打在 Facade 的转发方法上 ⇒ **覆写仍然生效**（真正的写入不会发生）。
 *
 * ⚠️ 这与「实现必须留 Facade」**不同**：留 Facade 的是「**被覆写的那个属性**」，
 * 不是「全部实现」——真正的写入逻辑在本类里。
 *
 * ## 注入面（**窄签名**）
 *
 * | 成员 | 留 Facade 的理由 | 谁在用它 |
 * |---|---|---|
 * | `storeLogLines` | **被既有 spec 赋值式覆写**（4 处，见上）⇒ Facade 保留同名转发方法，覆写仍生效 | 本类的 `persistCallbackLogsIfMissing` + Facade 的 `handleCallback` 注入面 |
 * | `hasStreamedLogLines` | **被既有 spec 赋值式覆写**（3 处）⇒ 同上 | 本类的 `persistCallbackLogsIfMissing` + Facade 的注入面 |
 * | `backfillFullLogsFromExecutor` | **被既有 spec spy 在 private 上**（`task.service.spec.ts:5751`/`:5796`）⇒ 留 Facade | 本类的 `persistCallbackLogsIfMissing` |
 */

/** 注入回调面（**窄签名**）。 */
export interface ExecutionLogDeps {
  /** 数据源（两个事务体）。 */
  dataSource: DataSource;
  /** 执行记录仓库（`appendLogChunk` 的存在性校验 / `storeLogLines` 的指针收回）。 */
  execRepo: Repository<TaskExecution>;
  /** 日志行仓库（`hasStreamedLogLines` 的计数）。 */
  logLineRepo: Repository<ExecutionLogLine>;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
  /**
   * S3/MinIO 日志后端解析（Facade 的 `resolveS3Storage`）。
   *
   * **留 Facade 的理由**：它持有 `configService` 与两个**缓存字段**
   * （`s3LogStorage` / `s3StorageResolved`）——那是 Facade 的运行态，不该被
   * 搬进协作者（否则两份缓存会各写各的）。
   */
  resolveS3Storage: () => S3LogStorage | null;
  /**
   * 读 S3 上已存在的日志内容（Facade 的 `s3GetExistingLog`）。
   *
   * **留 Facade 的理由**：同上是 Facade 的 S3 运行态；且它**带 warn 语义**
   *（S3 故障时 warn 一次，「append 回退可能丢前几页」）——留在 Facade 可复用
   * 既有日志口径。
   */
  s3GetExistingLog: (
    s3: S3LogStorage,
    executionId: string,
  ) => Promise<string | null>;
  /**
   * 写入日志行（**Facade 的同名转发方法**）。
   *
   * ⚠️ 必须是 **Facade 的**（不是本类的）：既有 spec 对它做**赋值式覆写**
   * （`execution-attempt-seq.spec.ts:576` 等 4 处）⇒ 经它调用，覆写才生效。
   */
  storeLogLines: (
    executionId: string,
    logs: string | string[],
    startLineNumber?: number,
    opts?: { append?: boolean },
  ) => Promise<void>;
  /** 是否已有实时流式日志行（**Facade 的同名转发方法**——同样被赋值式覆写）。 */
  hasStreamedLogLines: (executionId: string) => Promise<boolean>;
  /** 从执行器回填完整日志（**留 Facade**：被既有 spec spy 在 private 上）。 */
  backfillFullLogsFromExecutor: (
    execution: TaskExecution & { executorAddress?: string | null },
    executorAddress: string,
  ) => Promise<boolean>;
}

export class ExecutionLog {
  private readonly deps: ExecutionLogDeps;

  constructor(deps: ExecutionLogDeps) {
    this.deps = deps;
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
  async storeLogLines(
    executionId: string,
    logs: string | string[],
    startLineNumber = 0,
    opts: { append?: boolean } = {},
  ): Promise<void> {
    const lines = typeof logs === "string" ? logs.split("\n") : logs;
    const append = opts.append === true;
    const s3 = this.deps.resolveS3Storage();
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
          existing = await this.deps.s3GetExistingLog(s3, executionId);
          if (existing !== null && existing.length > 0) {
            content = `${existing}\n${content}`;
          }
        }
        const key = await s3.put(executionId, content);
        if (!append) {
          await this.deps.logLineRepo.delete({ executionId });
        }
        await this.deps.execRepo.update(executionId, {
          logStorage: "s3",
          logObjectKey: key,
        });
        return;
      } catch (err: unknown) {
        s3Failed = true;
        this.deps.logger.warn(
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
      this.deps.logLineRepo.create({
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
    await this.deps.dataSource.transaction(async (manager) => {
      if (fallbackReplace) {
        await manager.delete(ExecutionLogLine, { executionId });
      }
      for (let i = 0; i < entities.length; i += CHUNK) {
        await manager.save(ExecutionLogLine, entities.slice(i, i + CHUNK));
      }
    });
    if (s3Failed) {
      // 事务成功后收回指针（顺序不可换：先改指针再写行会闪出"无行可读"窗口）
      await this.deps.execRepo.update(executionId, {
        logStorage: "db",
        logObjectKey: null,
      });
    }
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
    const exec = await this.deps.execRepo.findOne({
      where: { id: executionId },
      select: { id: true, status: true },
    });
    if (!exec) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId,
      });
    }

    const entities = lines.map((content, i) =>
      this.deps.logLineRepo.create({
        executionId,
        lineNumber: fromLine + i,
        content,
        level: levelOfLine(content),
      }),
    );

    const CHUNK = 500;
    await this.deps.dataSource.transaction(async (manager) => {
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
  async persistCallbackLogsIfMissing(
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
        stored = await this.deps.backfillFullLogsFromExecutor(
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
          // ⚠️ 必须经 `deps`（Facade 的转发方法）——既有 spec 对
          // `hasStreamedLogLines` 做**赋值式覆写**（`execution-attempt-seq.spec.ts:577`
          // 等 3 处）⇒ 直调本类会让覆写打不到 ⇒ 隔离性静默丢失。
          (await this.deps.hasStreamedLogLines(cb.executionId));
        if (!keepStreamed) {
          await this.deps.storeLogLines(cb.executionId, cb.logs);
        }
      }
    } catch (err: unknown) {
      this.deps.logger.warn(
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
  async hasStreamedLogLines(executionId: string): Promise<boolean> {
    return (await this.deps.logLineRepo.count({ where: { executionId } })) > 0;
  }
}
